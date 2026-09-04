// AI 逐字歌词处理模块
// 从 LibFrontendPlay 获取当前播放音频，连同 original 歌词纯文本一起发送到本地
// LRC-Maker AI 后端（默认 http://127.0.0.1:8000），用返回的逐字歌词替换 dynamicLyric。
//
// 后端协议参考 LRC-Maker AI 辅助对齐油猴脚本：
//   - GET  /api/ping   -> { app: "lrc-maker-ai" } 用于端口探测
//   - POST /api/align  -> FormData(audio, lyrics, ti, ar, al)
//                         返回 { code: 200, data: { standard_lrc, enhanced_lrc } }
//   enhanced_lrc 为 ESLRC 逐字格式：行首 [mm:ss.xx] 为行起始，每个词后跟 [mm:ss.xx] 为词结束时间

import { getSetting, cyrb53 } from './utils.js';

// 注：曾有 wake-timer.js 用 blob: Worker 实现"防节流定时器"，但 orpheus:// 宿主的 CSP
// 禁止 blob: Worker（script-src 白名单无 blob:，worker-src 未设置而回退 script-src），
// Worker 必然创建失败，该方案已移除。最小化时的停摆风险已由"事件驱动等待"
// （waitUntilAudioAligned / waitForAudioMetadata 的事件路径）消化，定时器仅作兜底，
// 被节流时只会变慢、不会出错。
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const AI_BACKEND_START_PORT = 8000;
const AI_BACKEND_MAX_TRIES = 10;

// AI 逐字歌词结果缓存：避免同一首歌（单曲循环/切歌时多次触发 onProcessLyrics）重复请求后端。
// key 为 `${songId}-${lyricHash}`（songId 用 expectedSongId，lyricHash 用歌词文本的 cyrb53）。
// value 为 applyAILyric 处理后的歌词数组（含 dynamicLyric）。
// 只缓存最近几首，防止内存无限增长。
const aiLyricResultCache = new Map();
const AI_LYRIC_CACHE_MAX = 10;

// 正在处理中的 AI 请求 key 集合：避免同一首歌并发触发多个相同请求。
// 切歌时网易云可能短时间内多次调用 onProcessLyrics，若每次都发请求会浪费流量。
const pendingAIRequests = new Set();

// 写入 AI 歌词结果缓存（超出上限时淘汰最旧的）
const cacheAILyricResult = (key, lyrics) => {
	aiLyricResultCache.set(key, lyrics);
	if (aiLyricResultCache.size > AI_LYRIC_CACHE_MAX) {
		const oldestKey = aiLyricResultCache.keys().next().value;
		aiLyricResultCache.delete(oldestKey);
	}
};

// 计算 AI 歌词缓存 key：基于歌曲身份 + 歌词文本
// expectedSongId 可能为 undefined（本地歌词），此时退回用歌词文本 hash
const getAILyricCacheKey = (lyrics, expectedSongId) => {
	const text = (lyrics ?? []).map((x) => x?.originalLyric ?? '').join('\\');
	const lyricHash = cyrb53(text);
	return `${expectedSongId ?? 'local'}-${lyricHash}`;
};

// 获取当前播放歌曲的期望时长（秒），用于等待音频元素切换到新歌。
// 网易云歌曲对象带 dt 字段（毫秒）。取不到时返回 null（退回旧逻辑）。
// 关键：切歌时 LibFrontendPlay 复用同一 <audio> 元素，其 readyState/duration
// 可能仍是上一首歌的旧元数据，必须用新歌期望时长来判断音频是否已切换。
const getExpectedDurationSec = () => {
	try {
		const playing = betterncm?.ncm?.getPlaying?.();
		const dt = playing?.dt;
		if (dt && isFinite(dt) && dt > 0) return dt / 1000;
	} catch (e) {
		// 忽略
	}
	return null;
};

// 记录最近一次成功处理的歌曲身份，用于在 getPlaying().dt 不可用时，
// 检测音频元素是否仍是旧歌元数据（切歌竞态）。
let lastProcessedSongId = null;
let lastProcessedSrc = null;

// 判断音频元素是否可能是旧歌元数据（切歌竞态）。
// 原理：若音频身份（src/localPath）仍是上一首处理过的歌曲、但当前播放的已是新歌，
// 说明 LibFrontendPlay 复用的 <audio> 元素还没切到新歌，其 readyState/duration 是旧歌的。
// 首播（从未处理过）时返回 false，不阻塞正常流程。
// el：正在检查就绪状态的 audio 元素。若它不是当前播放元素（LibFrontendPlay 重建了新元素），
// 则视为"旧元素"，返回 true（不算就绪），避免在旧元素的旧元数据上误判。
const isAudioStale = (el) => {
	try {
		if (lastProcessedSongId == null) return false; // 首播，无旧歌可复用
		const cur = getCurrentAudio() ?? {};
		// 传入元素不是当前播放元素 → 已重建新元素，旧元素不算数
		if (el && cur.audio && el !== cur.audio) return true;
		const curIdentity = cur.localPath || cur.audio?.src || null;
		// 音频身份已变化 → 已切到新歌，不是旧元数据
		if (curIdentity && lastProcessedSrc && curIdentity !== lastProcessedSrc) return false;
		// 音频身份仍是上一首的，且当前播放的已是新歌 → 音频元素是旧元数据
		const playingId = betterncm?.ncm?.getPlaying?.()?.id;
		return playingId != null && String(playingId) !== String(lastProcessedSongId);
	} catch (e) {
		return false;
	}
};

// 音频 Blob 内存缓存：避免同一首歌重复下载浪费流量。
// key 为在线歌曲的 audio.src 或本地文件的 localPath，value 为下载好的完整 Blob。
// 只缓存最近几首，防止内存无限增长。
const audioBlobCache = new Map();
const AUDIO_CACHE_MAX = 5;

// 获取音频缓存 key（在线优先用 songID，本地用 localPath）
// 在线歌曲的 CDN URL 带时间戳，同一首歌再次播放时 URL 可能变化，
// 若用 src 作 key 会导致缓存永远命中不了；songID 稳定，可正确复用缓存。
const getAudioCacheKey = (audio, localPath) => {
	if (localPath) return localPath;
	try {
		const id = betterncm?.ncm?.getPlaying?.()?.id;
		if (id != null) return `song:${id}`;
	} catch (e) {
		// 忽略
	}
	return audio?.src || null;
};

// 写入缓存（超出上限时淘汰最旧的）
const cacheAudioBlob = (key, blob) => {
	if (!key || !blob) return;
	audioBlobCache.set(key, blob);
	if (audioBlobCache.size > AUDIO_CACHE_MAX) {
		const oldestKey = audioBlobCache.keys().next().value;
		audioBlobCache.delete(oldestKey);
	}
};

// 读取缓存
const getCachedAudioBlob = (key) => (key ? audioBlobCache.get(key) : null);

// 用 AudioContext 解码音频 blob，返回其时长（秒）。失败返回 null。
// 用于校验下载的音频与当前播放歌曲是否一致（时长应大致匹配）。
const getAudioBlobDuration = async (blob) => {
	try {
		const AudioCtx = window.AudioContext || window.webkitAudioContext;
		if (!AudioCtx) return null;
		const ctx = new AudioCtx();
		try {
			const arrayBuffer = await blob.arrayBuffer();
			const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
			return audioBuffer.duration;
		} finally {
			// 及时关闭 AudioContext，避免资源泄漏
			try { ctx.close(); } catch (e) { /* 忽略 */ }
		}
	} catch (e) {
		console.warn('[AI Lyric] 解码音频时长失败', e);
		return null;
	}
};

// 校验下载的音频 blob 时长是否与当前播放歌曲一致。
// 若时长明显不符（差异 > 5 秒），说明下载到了错误的歌曲（切歌竞态），返回 false。
// 时长无法获取（解码失败/无 duration）时保守放行，不阻塞正常流程。
const isBlobDurationMatching = async (blob, audio) => {
	const actual = await getAudioBlobDuration(blob);
	if (actual == null || !isFinite(actual) || actual <= 0) return true; // 无法解码，放行

	// 优先用 getPlaying().dt 作为期望时长（网易云歌曲对象的真实时长，最可靠）。
	// 关键：audio 元素的 duration 可能是上一首歌的旧元数据（切歌时 LibFrontendPlay
	// 复用同一 <audio> 元素，其 duration 还没更新到新歌），用它校验会把"已下载到的新歌"
	// 误判为旧歌。而 getPlaying().dt 始终是当前播放歌曲的真实时长，不会受 audio 元素
	// 元数据滞后影响。因此只要 getPlaying().dt 可用，就完全以它为准。
	const expectedFromPlaying = getExpectedDurationSec();
	if (expectedFromPlaying != null && isFinite(expectedFromPlaying) && expectedFromPlaying > 0) {
		const diff = Math.abs(actual - expectedFromPlaying);
		if (diff > 5) {
			console.warn(`[AI Lyric] 音频时长与期望歌曲不符（getPlaying）：blob=${actual.toFixed(1)}s，期望=${expectedFromPlaying.toFixed(1)}s`);
			return false;
		}
		// getPlaying().dt 可用且匹配，直接放行（不再用 audio.duration，避免旧元数据误判）
		return true;
	}

	// getPlaying().dt 不可用时，退回用 audio 元素 duration 校验（此时无更可靠来源）
	const expected = audio?.duration;
	if (!expected || !isFinite(expected) || expected <= 0) return true; // 无参考时长，放行
	// 允许 5 秒误差（不同编码/截断可能略有差异）
	const diff = Math.abs(actual - expected);
	if (diff > 5) {
		console.warn(`[AI Lyric] 音频时长不匹配，疑似下载到错误歌曲：blob=${actual.toFixed(1)}s，当前播放=${expected.toFixed(1)}s`);
		return false;
	}
	return true;
};

// 从 LibFrontendPlay 获取当前播放的 <audio> 元素及本地文件路径（若有）
// 返回 { audio, localPath }：
//   - audio: 当前播放的 <audio> 元素
//   - localPath: 若为本地文件则返回原始路径（用于 betterncm.fs.readFile），否则为 null
export const getCurrentAudio = () => {
	try {
		const plugin = window.loadedPlugins?.['LibFrontendPlay'];
		if (!plugin || !plugin.enabled) return null;
		const audio = plugin.currentAudioPlayer;
		if (!audio || !audio.src) return null;

		// 从 LibFrontendPlay 的 info.url 解析本地文件路径
		// 在线歌曲: info.url = "(online) <musicurl>"
		// 本地歌曲: info.url = "(local) <path>"
		let localPath = null;
		try {
			const infoUrl = plugin.info?.url ?? '';
			if (typeof infoUrl === 'string' && infoUrl.startsWith('(local)')) {
				localPath = infoUrl.replace(/^\(local\)\s*/, '').trim() || null;
			}
		} catch (e) {
			// 忽略解析失败
		}

		return { audio, localPath };
	} catch (e) {
		console.warn('[AI Lyric] 获取 LibFrontendPlay 音频失败', e);
		return null;
	}
};

// 等待音频元数据就绪（duration 可用），确保 audio.src 已切换到新歌且可下载。
// 注意：这里只等元数据，不等待缓冲完整——因为完整音频由后续 fetch 直接下载，
// 下载完成即代表完整，无需依赖 audio 元素缓慢的流式缓冲（那会白白等几十秒）。
// 
// 处理策略：
//   1. 快速路径：若传入的 audio 元素已就绪且与期望歌曲一致则直接返回。
//   2. 事件监听：在传入的 audio 上监听 loadedmetadata。
//   3. 轮询兜底：定期重新获取 getCurrentAudio()，防止 LibFrontendPlay 切歌时
//      创建了新的 <audio> 元素导致旧元素永远不会触发 loadedmetadata。
//
// expectedDurationSec：期望歌曲时长（秒，来自 getPlaying().dt）。
//   关键：切歌时 LibFrontendPlay 复用同一 <audio> 元素，其 readyState/duration
//   可能仍是上一首歌的旧元数据，此时不能算"就绪"，必须等时长匹配新歌才算切换完成。
//   无期望时长时，用 isAudioStale() 检测音频元素是否仍是旧歌元数据，是则继续等待。
const waitForAudioMetadata = async (audio, expectedDurationSec = null, timeoutMs = 8000) => {
	// 判断 audio 元素是否已就绪且与期望歌曲一致
	const isReady = (el) => {
		if (!el || el.readyState < 1 || !(el.duration > 0)) return false;
		if (expectedDurationSec != null && isFinite(expectedDurationSec) && expectedDurationSec > 0) {
			return Math.abs(el.duration - expectedDurationSec) <= 2;
		}
		// 无期望时长时，若音频元素仍是旧歌元数据，则不算就绪
		return !isAudioStale(el);
	};

	// 元数据已就绪且与期望歌曲一致则直接返回
	if (isReady(audio)) return true;

	return new Promise((resolve) => {
		let resolved = false;
		// 等待音频元数据超时的截止定时器：窗口最小化时可能被节流推迟，
		// 只会让"尝试直接下载"来得更晚，方向安全（门禁在下游兜底归属校验）。
		const timeout = setTimeout(() => {
			if (resolved) return;
			resolved = true;
			cleanupAll();
			console.warn('[AI Lyric] 等待音频元数据超时，尝试直接下载');
			resolve(false);
		}, timeoutMs);

		const resolveOnce = () => {
			if (resolved) return;
			resolved = true;
			cleanupAll();
			resolve(true);
		};

		// 监听 loadedmetadata：事件触发时重新校验是否已切到新歌
		const onLoaded = (e) => {
			const el = e?.target ?? audio;
			if (isReady(el)) resolveOnce();
		};
		audio.addEventListener('loadedmetadata', onLoaded);

		// 竞态保护：本地文件加载极快，loadedmetadata 可能在添加监听前已触发
		if (isReady(audio)) {
			resolveOnce();
			return;
		}

		// 轮询兜底：每 500ms 重新获取 getCurrentAudio()，
		// 处理 LibFrontendPlay 切歌时重建 <audio> 元素的情况。
		// 当新 audio 元素就绪时，同时为其添加事件监听和检查 readyState。
		let pollTimer = null;
		const seenAudios = new Set([audio]); // 已监听过的 audio 元素，避免重复添加监听

		const poll = () => {
			if (resolved) return;
			try {
				const current = getCurrentAudio();
				const cur = current?.audio;
				if (cur && !seenAudios.has(cur)) {
					seenAudios.add(cur);
					cur.addEventListener('loadedmetadata', onLoaded);
					if (isReady(cur)) {
						resolveOnce();
						return;
					}
				}
			} catch (e) {
				// 忽略轮询中的异常
			}
		if (!resolved) {
			pollTimer = setTimeout(poll, 500);
		}
	};
	pollTimer = setTimeout(poll, 500);

	const cleanupAll = () => {
		clearTimeout(timeout);
		clearTimeout(pollTimer);
			// 移除所有已添加的事件监听
			seenAudios.forEach((el) => {
				el.removeEventListener('loadedmetadata', onLoaded);
			});
		};
	});
};

// 判断是否为"占位歌词"（纯音乐/暂无歌词等），这些没有实际歌词内容，不应发往后端。
// 网易云对无歌词歌曲会返回固定的占位文本，如：
//   - "纯音乐，请欣赏"（纯音乐）
//   - "暂无歌词"（无歌词）
// 这些文本没有逐字对齐价值，发给后端只会浪费流量并可能产生错误结果。
const isPlaceholderLyric = (text) => {
	if (!text) return false;
	const t = text.trim();
	if (!t) return false;
	// 整段文本只由占位句 + 元数据行（作词/作曲等）组成时视为占位歌词
	const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
	if (lines.length === 0) return false;
	// 至少包含一个明确的占位句
	const hasPlaceholder = lines.some((l) => /^(纯音乐，请欣赏|暂无歌词|纯音乐|无歌词)$/.test(l));
	if (!hasPlaceholder) return false;
	// 其余行只能是元数据行（作词/作曲/编曲等），否则视为有真实歌词
	return lines.every((l) => /^(纯音乐，请欣赏|暂无歌词|纯音乐|无歌词)$/.test(l) || isMetadataLine(l));
};

// 把解析后的歌词行拼成带换行的纯文本（仅原文，按时间顺序）
const buildOriginalLyricText = (lyrics) => {
	if (!Array.isArray(lyrics)) return { text: '', times: [], start: 0 };
	const lines = lyrics.map((line) => line?.originalLyric ?? '');
	// 去掉首尾空行，保持与后端 raw_lines 一致
	let start = 0, end = lines.length;
	while (start < end && !lines[start].trim()) start++;
	while (end > start && !lines[end - 1].trim()) end--;
	const trimmed = lines.slice(start, end);
	return {
		text: trimmed.join('\n').trim(),
		// 每行参考时间（秒），对应后端 raw_lines 的每一行
		times: trimmed.map((_, i) => (lyrics[start + i]?.time ?? 0) / 1000),
		// 发送文本第一行对应原始歌词的索引（用于按行号一一对应）
		start,
	};
};

// 探测本地 AI 后端端口
const findActiveBackendPort = async (startPort = AI_BACKEND_START_PORT, maxTries = AI_BACKEND_MAX_TRIES) => {
	for (let port = startPort; port < startPort + maxTries; port++) {
		try {
			const controller = new AbortController();
			// 探测超时的 abort 兜底：连接拒绝由系统层立即返回，此定时器只防极慢响应，
			// 最小化被节流时最多让单个死端口的等待变长，不影响正常流程
			const timeoutId = setTimeout(() => controller.abort(), 300);
			const response = await fetch(`http://127.0.0.1:${port}/api/ping`, {
				signal: controller.signal,
			});
			clearTimeout(timeoutId);
			if (response.ok) {
				const data = await response.json();
				if (data.app === 'lrc-maker-ai') {
					console.log(`[AI Lyric] 探测到后端端口: ${port}`);
					return port;
				}
			}
		} catch (e) {
			// 端口未响应，继续尝试
		}
	}
	throw new Error('未探测到本地 AI 引擎，请确认后端已启动');
};

// 把音频 blob + 歌词文本发送到后端，返回 { standardLrc, enhancedLrc }
// audioFileName 用于让后端识别音频格式（在线歌曲默认 audio.bin，本地文件用其扩展名）
const requestAILyric = async (audioBlob, originalLyricText, songInfo, times, audioFileName = 'audio.bin') => {
	const activePort = await findActiveBackendPort();

	const formData = new FormData();
	formData.append('audio', audioBlob, audioFileName);
	formData.append('lyrics', originalLyricText);
	if (Array.isArray(times) && times.length > 0) {
		formData.append('times', JSON.stringify(times));
	}
	formData.append('ti', songInfo?.name ?? '');
	formData.append('ar', songInfo?.artist ?? '');
	formData.append('al', songInfo?.album ?? '');

	const response = await fetch(`http://127.0.0.1:${activePort}/api/align`, {
		method: 'POST',
		body: formData,
	});

	if (!response.ok) {
		throw new Error(`后端返回错误状态码: ${response.status}`);
	}

	const resJson = await response.json();
	if (resJson.code !== 200) {
		throw new Error(resJson.message || '后端处理失败');
	}

	const lrcData = resJson.data;
	// data 可能是字符串，也可能是 { standard_lrc, enhanced_lrc }
	if (typeof lrcData === 'string') {
		return { standardLrc: lrcData, enhancedLrc: lrcData };
	}
	const standardLrc = lrcData?.standard_lrc;
	const enhancedLrc = lrcData?.enhanced_lrc;
	if (!enhancedLrc) {
		throw new Error('后端未返回逐字歌词 (enhanced_lrc)');
	}
	return { standardLrc, enhancedLrc };
};

// 解析 ESLRC 逐字歌词格式，转换为 DynamicLyricWord[]
// 例（无停顿）：[00:12.34]我[00:13.00]爱[00:13.50]你[00:14.20]
// 例（词2后有停顿）：[00:12.34]我[00:13.00]爱[00:13.50][00:15.00]你[00:15.80]
const parseEnhancedLrc = (lrc) => {
	const lines = [];
	const lineStartReg = /^\[(\d{2}):(\d{2}\.\d{2})\]/;
	const wordReg = /([^\[\]]+)((?:\[\d{2}:\d{2}\.\d{2}\])+)/g;
	const timeReg = /\[(\d{2}):(\d{2}\.\d{2})\]/g;

	lrc.split('\n').forEach((lineStr) => {
		const line = { time: 0, words: [] };
		const lineStartMatch = lineStartReg.exec(lineStr);
		const hasLineStart = lineStartMatch !== null;
		let nextStart = lineStartMatch
			? parseInt(lineStartMatch[1]) * 60 + parseFloat(lineStartMatch[2])
			: null;
		if (nextStart !== null) line.time = Math.round(nextStart * 1000);

		// 行内容（去掉行首时间戳后的剩余文本），用于判断是否为空行
		const content = lineStartMatch
			? lineStr.slice(lineStartMatch[0].length).trim()
			: lineStr.trim();

		let match;
		wordReg.lastIndex = 0;
		while ((match = wordReg.exec(lineStr)) !== null) {
			// 保留尾空格（trimStart 只去前导空格），以便标记 endsWithSpace
			const text = match[1].trimStart();
			if (!text) continue;

			const stamps = [];
			let tm;
			timeReg.lastIndex = 0;
			while ((tm = timeReg.exec(match[2])) !== null) {
				stamps.push(parseInt(tm[1]) * 60 + parseFloat(tm[2]));
			}

			const end = stamps[0];
			const start = nextStart !== null ? nextStart : end;
			line.words.push({
				time: Math.round(start * 1000),
				duration: Math.round((end - start) * 1000),
				flag: 0,
				word: text,
			});

			// 有第二个时间戳说明词间有停顿，下一词从该时间戳开始；否则无缝衔接
			nextStart = stamps.length > 1 ? stamps[1] : end;
		}
		// 保留有逐字词的行，或带行开始时间戳且有实际文本内容的行（元数据行/间奏行）
		// 忽略纯空行（如 [01:04.88] 只有空格）——它们会导致翻译/罗马音错位
		if (line.words.length > 0 || (hasLineStart && content.length > 0)) {
			// 行结束时间 = 最后一个词的结束时间
			const lastWord = line.words[line.words.length - 1];
			if (lastWord) {
				line.end = lastWord.time + lastWord.duration;
			}
			lines.push(line);
		}
	});
	return lines;
};

// 后处理：标记 CJK 字符和空格结尾（供 lyrics.js 渲染层使用）
const postProcessDynamicLyric = (lines) => {
	const CJKRegex = /([\p{Unified_Ideograph}|\u3040-\u309F|\u30A0-\u30FF])/gu;
	for (const line of lines) {
		const dynamic = line.words || [];
		for (let i = 0; i < dynamic.length; i++) {
			const word = dynamic[i];
			if (word?.word?.match(CJKRegex)) word.isCJK = true;
			if (word?.word?.match(/\s$/)) word.endsWithSpace = true;
		}
	}
	return lines;
};

// 解析标准 LRC 歌词，返回 [{ time, lyric }]（按时间排序）
// 保留作词/作曲等元数据行（它们应显示自己的文本，只是不附加逐字词）
const parseStandardLrc = (lrc) => {
	const lines = [];
	const timeReg = /\[(\d{1,2}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
	for (const lineStr of lrc.split('\n')) {
		let text = lineStr;
		const times = [];
		let match;
		timeReg.lastIndex = 0;
		while ((match = timeReg.exec(text)) !== null) {
			const min = parseInt(match[1]);
			const sec = parseFloat(match[2].replace(':', '.'));
			times.push(Math.round((min * 60 + sec) * 1000));
			text = text.slice(0, match.index) + text.slice(match.index + match[0].length);
			timeReg.lastIndex = match.index;
		}
		text = text.trim();
		// 保留空行（间奏行）：有时间戳但无文本
		if (!text && times.length === 0) continue;
		for (const time of times) {
			lines.push({ time, lyric: text });
		}
	}
	return lines.sort((a, b) => a.time - b.time);
};

// 判断是否为元数据行（作詞/作曲/編曲等 Staff 信息），这些行应显示自己的文本，只是不附加逐字
// 关键词后允许有可选空白再跟冒号（如 "作词 : Nami Tape"、"作曲：xxx"）
export const isMetadataLine = (text) => {
	if (!text) return false;
	return /^(作詞|作曲|編曲|作词|作曲|编曲|作詞者|作曲者|編曲者|作词者|作曲者|编曲者|歌詞|歌词|訳詞|译词|翻譯|翻译|原唱|演唱|製作|制作|監製|监制|企劃|企划|出品|发行|發行|原曲|和声|和聲|伴唱|混音|母带|母帶|录音|錄音|制作人|製作人)\s*[:：]/.test(text);
};

// 把逐字歌词行对齐到标准 LRC 行，重建歌词数组
// 以原歌词为基础（保留所有行，包括元数据/间奏），用标准 LRC 修正文本和时间，
// 用增强 LRC 提供逐字数据（dynamicLyric）
//
// 核心前提：后端是基于我们发送的原始歌词文本做对齐的，返回的 standard_lrc /
// enhanced_lrc 行数与发送文本一致（含间奏空行/元数据行），每行按行号一一对应，
// 因此直接按 index 对齐即可，无需任何时间/文本匹配。
// 所有行（含元数据行/间奏空行）都用标准行文本和时间；元数据行不附加逐字。
const mergeLyrics = (standardLines, enhancedLines, originalLyrics, startOffset = 0) => {
	// 过滤掉后端插入的间奏空行（standard 中无文本的行），
	// 保证与 enhancedLines（parseEnhancedLrc 已忽略纯空行）行数一致、按行号一一对应
	const stdContent = standardLines.filter((l) => l.lyric.trim().length > 0);

	// 原始歌词中非空行按顺序消费后端内容行（原始空行/间奏保持原样，不消费后端行）
	let contentIdx = startOffset;
	return originalLyrics.map((origLine, i) => {
		const base = { ...origLine };
		// 原始空行（间奏）保持原样
		if ((origLine.originalLyric ?? '').trim().length === 0) return base;

		const idx = contentIdx - startOffset;
		contentIdx++;
		// 超出后端返回范围的行（首尾空行）保持原样
		if (idx < 0 || idx >= stdContent.length) {
			return base;
		}

		const stdLine = stdContent[idx];
		const isMeta = isMetadataLine(stdLine.lyric);

		// 标准行修正文本和时间（所有行都显示标准行文本，包括元数据行/间奏空行）
		base.originalLyric = stdLine.lyric;
		// 元数据行保留 processLyrics 已重写好的 1 秒递增时间戳（供其他插件与 CD 页一致），
		// 不覆盖为标准 LRC 的原始时间；非元数据行才用标准行时间
		if (!isMeta) {
			base.time = stdLine.time;
		}

		// 元数据行不附加逐字，并清除原始歌词行（官方 YRC）自带的 dynamicLyric；
		// 设置 1 秒 duration，使其他插件（如 lyricbar）能正确显示每行 1 秒的时长
		// （与 CD 页 metadataDisplayDuration 一致），而不是持续到歌曲结尾
		if (isMeta) {
			delete base.dynamicLyric;
			delete base.dynamicLyricTime;
			base.duration = 1000;
		}

		// 附加逐字数据（元数据行不需要逐字）
		if (!isMeta && idx < enhancedLines.length) {
			const enhLine = enhancedLines[idx];
			if (enhLine && enhLine.words && enhLine.words.length > 0) {
				base.duration = (enhLine.end ?? enhLine.time ?? base.time) - (enhLine.time ?? base.time);
				base.dynamicLyric = enhLine.words;
				base.dynamicLyricTime = enhLine.time ?? base.time;
			}
		}
		return base;
	});
};

// 从 betterncm 获取当前歌曲信息（歌名/歌手/专辑）
const getSongInfo = () => {
	try {
		const playing = betterncm?.ncm?.getPlaying?.();
		if (!playing) return null;
		return {
			name: playing.name ?? '',
			artist: (playing.artists ?? []).map((a) => a.name).join(' / '),
			album: playing.album?.name ?? '',
		};
	} catch (e) {
		return null;
	}
};

// 【PROBE】仅供排障日志使用：返回当前 getPlaying() 的歌名（尽力而为）
const songTitleProbe = () => {
	try {
		return betterncm?.ncm?.getPlaying?.()?.name ?? '(null)';
	} catch (e) {
		return '(err)';
	}
};

// 判断当前播放的歌曲是否仍与期望的歌曲一致。
// 用于在异步 AI 处理期间检测用户是否已切歌：若已切歌则中止本次处理，
// 避免把"上一首的歌词文本 + 当前播放的音频"错配发给后端。
// expectedSongId: onProcessLyrics 回调传入的 songID（可能为 undefined）
// expectedSrc:    触发处理时捕获的 audio.src / localPath
const isSongStillCurrent = (expectedSongId, expectedSrc) => {
	try {
		// 1) 优先用 songID 校验（网易云切歌时 id 会变化）
		if (expectedSongId != null) {
			const playingId = betterncm?.ncm?.getPlaying?.()?.id;
			// songID 可用且能取到当前 id 时，以 songID 为准（同一首歌 src 可能变化，不据此误判）
			if (playingId != null) {
				return String(playingId) === String(expectedSongId);
			}
			// songID 可用但取不到当前 id 时，退回用 src 校验
		}
		// 2) 用音频 src/localPath 校验（songID 不可用或取不到当前 id 时兜底）
		if (expectedSrc) {
			const cur = getCurrentAudio() ?? {};
			const curSrc = cur.localPath || cur.audio?.src || null;
			if (curSrc && curSrc !== expectedSrc) {
				return false;
			}
		}
		return true;
	} catch (e) {
		// 校验失败时保守起见放行（不阻塞正常流程）
		return true;
	}
};

// 【PROBE 限频】unknown/unaligned 诊断日志最多每秒一条，避免刷屏
let lastAlignProbeAt = 0;

// ===== 尺子 2：换源时序绑定（不依赖 dt，本地歌曲的主尺子）=====
// 原理：LibFrontendPlay 派发 updateCurrentAudioPlayer 的瞬间正在换/刚换好音频源，
// 而歌词回调（onProcessLyrics）先于音频换源触发（运行日志已证实），因此换源瞬间
// getPlaying().id 必然已指向目标歌。记录"最近一次换源瞬间 getPlaying().id"，
// 与期望歌 ID 一致即证明音频源已切实换到本首歌——对 src 为不透明 token 的
// 本地歌曲（http://localhost:5451/mounted_file/...）同样有效。
// 实测：本地歌曲 getPlaying().dt 为 undefined，dt 尺子对这些歌永远 unknown，
// 故本尺子是本地场景下唯一可靠的归属裁决。
let swapSongId = null; // 最近一次换源事件触发瞬间 getPlaying().id
let swapObserved = false; // 本会话是否观察到过换源事件
let swapWatcherInstalled = false;

// 全局安装换源监听（安装后常驻，不随单次等待清理——绑定状态需跨等待累积）。
// LFP 可能在本模块加载后才就绪，故除模块初始化外，每次门禁等待入口与兜底轮询都会重试安装。
const ensureSwapWatcher = () => {
	if (swapWatcherInstalled) return;
	const lfp = window.loadedPlugins?.LibFrontendPlay;
	if (!lfp?.addEventListener) return;
	try {
		lfp.addEventListener('updateCurrentAudioPlayer', () => {
			swapObserved = true;
			try {
				swapSongId = betterncm?.ncm?.getPlaying?.()?.id ?? null;
			} catch (e) {
				// 忽略：保留上一次绑定
			}
		});
		swapWatcherInstalled = true;
	} catch (e) {
		// 忽略，下次重试
	}
};

// 判定换源绑定：'aligned'（本会话最近一次换源绑定的歌就是期望歌）｜'unaligned'｜'unknown'
const judgeSwapBinding = (expectedSongId) => {
	if (!swapObserved || expectedSongId == null || swapSongId == null) return 'unknown';
	return String(swapSongId) === String(expectedSongId) ? 'aligned' : 'unaligned';
};

// 模块加载即尝试安装换源监听：LFP 若已就绪则尽早开始积累绑定状态
ensureSwapWatcher();

// 判断"当前音频元素相对于本首歌的对齐程度"。
//
// 背景：切歌瞬间 onProcessLyrics 触发时，LibFrontendPlay 复用的 <audio> 元素常常
// 还挂着上一首歌的 src/metadata（这也是当初捕获的 expectedSrc 可能被污染成旧歌的原因）。
// 若不加以甄别就拿 getCurrentAudio() 的返回值去下载，会把"上一首的音频 + 当前歌词"错配
// 发给后端（表现为：音频是旧的、歌词是新的）。
//
// 双尺子合成裁决（任一 aligned 即可信；两把尺子打架时保守按 unknown 继续等）：
//   尺子 1 —— dt 时长对比：getPlaying().dt 与 audio.duration 逼近（在线歌曲 dt 可得时最直接；
//             实测本地歌曲 dt 为 undefined，此尺子对它们恒为 unknown）。
//   尺子 2 —— 换源时序绑定：本会话最近一次 updateCurrentAudioPlayer 绑定的歌 ID 与期望一致
//             （不依赖 dt，本地歌曲的主尺子；会话内从未观察到换源事件时为 unknown）。
//
// ⚠️ 关键约定（吸取教训）：本函数返回三种状态，唯有 'aligned' 才是"可以放心下载"。
// 任何"说不准"的情形都必须如实上报为 'unknown'，严禁乐观放行。"宁可多等或放弃，
// 绝不冒拿旧音频出手的险"是本函数的铁律。
//
// 返回：
//   - 'aligned'   ：至少一把尺子确认音频已切到本首歌，可放心下载。
//   - 'unaligned' ：有尺子确认音频还滞留在别的歌上。
//   - 'unknown'   ：缺乏足够的可信依据，无法断定已对齐。
const judgeAudioAlignment = (expectedSongId) => {
	try {
		const reasons = [];
		const verdicts = [];

		// 尺子 2：换源时序绑定
		const swapVerdict = judgeSwapBinding(expectedSongId);
		verdicts.push(swapVerdict);
		reasons.push(`换源绑定=${swapVerdict}(bound=${swapSongId ?? '(null)'})`);

		// 尺子 1：dt 时长对比
		const playing = betterncm?.ncm?.getPlaying?.();
		const dtRaw = playing?.dt;
		const expectedDur = (dtRaw && isFinite(dtRaw) && dtRaw > 0) ? dtRaw / 1000 : null;
		const cur = getCurrentAudio() ?? {};
		const audio = cur.audio ?? null;
		const dur = audio?.duration;
		let dtVerdict = 'unknown';
		if (expectedDur == null) {
			reasons.push(`dt 不可用 (dtRaw=${String(dtRaw)})`);
		} else if (dur == null || !isFinite(dur) || dur <= 0) {
			reasons.push(`audio 元数据不可用 (readyState=${audio ? audio.readyState : '无元素'})`);
		} else {
			dtVerdict = Math.abs(dur - expectedDur) <= 2 ? 'aligned' : 'unaligned';
			reasons.push(`dt=${expectedDur.toFixed(2)}s duration=${dur.toFixed(2)}s`);
		}
		verdicts.push(dtVerdict);

		// 合成：aligned 与 unaligned 并存说明尺子打架，保守继续等
		let verdict;
		if (verdicts.includes('aligned') && verdicts.includes('unaligned')) verdict = 'unknown';
		else if (verdicts.includes('aligned')) verdict = 'aligned';
		else if (verdicts.includes('unaligned')) verdict = 'unaligned';
		else verdict = 'unknown';

		// 【PROBE】非 aligned 时限频取证
		const now = Date.now();
		if (verdict !== 'aligned' && now - lastAlignProbeAt >= 1000) {
			lastAlignProbeAt = now;
			console.log(
				`[AI Lyric][probe] judgeAudioAlignment=${verdict} | ${reasons.join(' | ')} | playing.id=${
					playing?.id ?? '(null)'
				} curAudio=${audio ? String(audio.src || '(src空)').slice(0, 80) : '(null)'} localPath=${cur.localPath ?? '(null)'}`
			);
		}
		return verdict;
	} catch (e) {
		return 'unknown';
	}
};

// 在当前歌曲身份保持不变的前提下，等待音频元素切实切到本首歌。
//
// 【事件驱动 + 低频兜底】（重构自定时器轮询版）
// 旧实现用 sleep(400) 轮询 judgeAudioAlignment，但 orpheus:// 宿主的 CSP
// 禁止 blob: Worker（wake-timer.js 曾退回主线程 setTimeout，该文件现已移除），窗口最小化时定时器被
// Chromium 节流到 ~1/min，7s 的等待窗口里几乎采不到样，合法的切歌被大面积误杀
// （日志表现："限定时间内未能确认音频已切到本首歌"）。
// 新实现让唤醒彻底摆脱定时器调度——三路信号都直接调用 evaluate() 立即采样判定，
// 而事件处理函数不受页面可见性节流影响：
//   信号 1：LibFrontendPlay 的 updateCurrentAudioPlayer 事件（切歌/换元素时天然触发，
//           e.detail 携新 audio 元素）。
//   信号 2：audio 元素自带媒体事件 loadedmetadata/durationchange/canplay（新歌元数据
//           就绪的瞬间触发）；元素换代时对新元素补绑（防监听在旧元素上落空）。
//   信号 3：低频 setInterval(~2.3s) 兜底（防个别事件漏发；频率压低，即便最小化被
//           节流也只是轻度劣化，且顺带周期重绑新元素）。
// 返回：'aligned'（已对齐，可下载）｜'switched'（已切歌，上层应终止）｜'giveup'（届满）。
// maxWaitMs 默认上调到 28s：等待本身不再空转烧 CPU，多给时间换取"尽量纠正而非放弃"。
const MEDIA_EVENT_HINTS = ['loadedmetadata', 'durationchange', 'canplay', 'playing', 'timeupdate'];

const waitUntilAudioAligned = (expectedSongId, expectedSrc, maxWaitMs = 28000) => {
	return new Promise((resolve) => {
		// 【v2 标识】事件驱动版入口日志：确认新代码已生效（旧轮询版无此日志）
		console.log(
			`[AI Lyric] 门禁等待音频对齐（事件驱动 v2）: expectedSongId=${expectedSongId ?? '(null)'} 限期=${maxWaitMs}ms`
		);
		let settled = false;
		let deadlineTimer = null;
		const seenAudios = new Set();
		const lfp = window.loadedPlugins?.LibFrontendPlay ?? null;

		const cleanup = () => {
			if (deadlineTimer != null) clearTimeout(deadlineTimer);
			if (fallbackTimer != null) clearInterval(fallbackTimer);
			if (lfp?.removeEventListener) {
				try { lfp.removeEventListener('updateCurrentAudioPlayer', onPlayerSwap); } catch (e) { /* 忽略 */ }
			}
			seenAudios.forEach((el) => {
				for (const ev of MEDIA_EVENT_HINTS) {
					el.removeEventListener(ev, evaluate);
				}
			});
			seenAudios.clear();
		};

		const finish = (result) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		};

		// 立即采样判定：检出切歌 → 'switched'；音频已切到本首歌 → 'aligned'；否则继续等下一信号
		const evaluate = () => {
			if (settled) return;
			if (!isSongStillCurrent(expectedSongId, expectedSrc)) {
				finish('switched');
				return;
			}
			if (judgeAudioAlignment(expectedSongId) === 'aligned') finish('aligned');
		};

		// 元素换代跟进：对新出现的 audio 元素补挂媒体事件（同一元素只绑一次）
		const bindMediaEvents = (el) => {
			if (!el || seenAudios.has(el)) return;
			seenAudios.add(el);
			for (const ev of MEDIA_EVENT_HINTS) {
				try { el.addEventListener(ev, evaluate); } catch (e) { /* 忽略 */ }
			}
		};

		// 信号 1：LibFrontendPlay 换元素事件（e.detail 携新 audio 元素）
		const onPlayerSwap = (e) => {
			bindMediaEvents(e?.detail ?? null);
			evaluate();
		};

		// 信号 3：低频兜底（防个别事件漏发 + 周期重绑新元素）
		let fallbackTimer = null;

		// 截止时间：最小化时该定时器可能被推迟触发，只会"多等"不会"早弃"，方向是安全的
		deadlineTimer = setTimeout(() => finish('giveup'), maxWaitMs);

		// 换源监听是绑定状态的数据源，LFP 晚就绪时在这里补装
		ensureSwapWatcher();

		if (lfp?.addEventListener) {
			try { lfp.addEventListener('updateCurrentAudioPlayer', onPlayerSwap); } catch (e) { /* 忽略 */ }
		}
		fallbackTimer = setInterval(() => {
			ensureSwapWatcher(); // 兜底轮询顺带重试安装换源监听（防 LFP 晚于本模块就绪）
			bindMediaEvents(getCurrentAudio()?.audio ?? null);
			evaluate();
		}, 2300);

		// 立即采样一次 + 绑定当前元素（快速路径：音频本就对齐时不产生任何等待）
		bindMediaEvents(getCurrentAudio()?.audio ?? null);
		evaluate();
	});
};

// 把后端返回的逐字歌词应用到现有歌词行上
// 返回新的歌词数组（替换了 dynamicLyric），失败时返回 null
// expectedSongId/expectedSrc：用于在异步处理期间检测切歌，若已切歌则中止
export async function applyAILyric(lyrics, expectedSongId, expectedSrc) {
	// 0. 设置中未启用 AI 逐字歌词时直接跳过（不探测端口、不下载音频）
	if (!getSetting('ai-lyric', true)) {
		return null;
	}

	// 0.5 缓存命中：同一首歌（相同 songId + 歌词文本）已处理过，直接复用结果，
	//     避免单曲循环/切歌时重复请求后端。
	const cacheKey = getAILyricCacheKey(lyrics, expectedSongId);
	if (aiLyricResultCache.has(cacheKey)) {
		console.log('[AI Lyric] 命中 AI 歌词结果缓存，跳过后端请求');
		return aiLyricResultCache.get(cacheKey);
	}

	// 0.6 防重入：同一首歌正在处理中时，跳过本次（避免并发重复请求）。
	//     切歌时网易云可能短时间内多次调用 onProcessLyrics，若每次都发请求会浪费流量。
	if (pendingAIRequests.has(cacheKey)) {
		console.log('[AI Lyric] 该歌曲正在处理中，跳过本次请求');
		return null;
	}
	pendingAIRequests.add(cacheKey);
	try {
		return await doApplyAILyric(lyrics, expectedSongId, expectedSrc, cacheKey);
	} finally {
		pendingAIRequests.delete(cacheKey);
	}
}

// applyAILyric 的实际处理逻辑（被 applyAILyric 的缓存/防重入包装调用）
async function doApplyAILyric(lyrics, expectedSongId, expectedSrc, aiCacheKey) {

	// 1. 没有歌词文本就不处理
	const { text: originalLyricText, times, start } = buildOriginalLyricText(lyrics);

	if (!originalLyricText) {
		console.log('[AI Lyric] 歌曲没有歌词文本，跳过 AI 处理');
		return null;
	}

	// 1.5 占位歌词（纯音乐/暂无歌词）不处理，避免误发后端
	if (isPlaceholderLyric(originalLyricText)) {
		console.log('[AI Lyric] 检测到占位歌词（纯音乐/暂无歌词），跳过 AI 处理:', JSON.stringify(originalLyricText));
		return null;
	}

	// 2. 获取当前音频及本地路径
	const { audio, localPath } = getCurrentAudio() ?? {};
	if (!audio) {
		// 未找到音频：开启网易云或尚未播放歌曲时，LibFrontendPlay 可能已加载但
		// 还没有 currentAudioPlayer，此时正常跳过即可，无需打印日志。
		return null;
	}
	// 计算期望歌曲时长（秒），用于等待音频元素切换到新歌
	const expectedDurationSec = getExpectedDurationSec();

	// 3. 只等音频元数据就绪（确保 src 已切换到新歌），不等待缓冲完整
	//    传入期望歌曲时长：切歌时 LibFrontendPlay 复用同一 <audio> 元素，
	//    其 readyState/duration 可能仍是上一首歌的旧元数据，必须等时长匹配新歌才算就绪。
	await waitForAudioMetadata(audio, expectedDurationSec);

	// 3.5 重新获取当前音频，确保 src/localPath 已切换到新歌。
	//     切歌瞬间触发本函数时，步骤 2 拿到的 audio.src 可能还是上一首歌的 URL，
	//     若直接用旧 src 计算缓存 key，会命中上一首歌的音频缓存，把旧歌音频发给后端。
	//     等待元数据就绪后 audio.src 已更新为新歌，此时重新读取才能拿到正确的缓存 key。
	const current = getCurrentAudio() ?? {};
	const currentAudio = current.audio ?? audio;
	const currentLocalPath = current.localPath ?? localPath;

	// 3.55 兜底：等待后音频元素仍是旧歌元数据（超时未切换），
	//      此时继续会用旧歌 src 计算缓存 key，把旧歌音频发给后端，直接中止。
	if (isAudioStale(currentAudio)) {
		console.warn('[AI Lyric] 等待后音频元素仍是旧歌元数据，中止本次 AI 处理');
		return null;
	}

	// 3.6 切歌检测：等待元数据期间用户可能已切到下一首。
	//     此时当前音频/歌曲信息已属于新歌，但本函数闭包里的 lyrics 仍是旧歌的，
	//     若继续会把"旧歌词 + 新音频"错配发给后端。检测到切歌则直接中止，
	//     新歌自己的 onProcessLyrics 会触发新的 AI 处理。
	if (!isSongStillCurrent(expectedSongId, expectedSrc)) {
		console.log('[AI Lyric] 处理期间检测到切歌，中止本次 AI 处理');
		return null;
	}

	// 4. 获取完整音频 blob（带重试 + 内存缓存）
	//    在线歌曲：audio.src 是 http(s) CDN 地址，用 fetch 下载。
	//    本地歌曲：audio.src 是 orpheus:// 等自定义协议，fetch 无法访问（Failed to fetch），
	//              需从 LibFrontendPlay 的 info.url 解析本地路径，用 betterncm.fs.readFile 读取完整文件。
	//    缓存：同一首歌（相同 src/localPath）重复播放时直接复用，避免重复下载浪费流量。
	//
	//    注意：每次重试前都重新 getCurrentAudio()，防止 LibFrontendPlay 在下载期间
	//    切歌创建了新 <audio> 元素，导致旧元素的 src 指向上一首歌的 CDN 地址。
	const downloadWithRetry = async () => {
		for (let attempt = 0; attempt < 3; attempt++) {
			// 每次尝试前重新获取当前音频（切歌时 LibFrontendPlay 会创建新 <audio> 元素）
			const fresh = getCurrentAudio() ?? {};
			const freshAudio = fresh.audio ?? currentAudio;
			const freshLocalPath = fresh.localPath ?? currentLocalPath;

			// 每次重试前校验是否切歌
			if (!isSongStillCurrent(expectedSongId, expectedSrc)) {
				console.log('[AI Lyric] 获取音频期间检测到切歌，中止本次 AI 处理');
				return { aborted: true };
			}

			// 【关键】音频归属门禁：确认当前 <audio> 元素已切实切到本首歌，再去碰它。
			// 切歌瞬间 LibFrontendPlay 复用的 <audio> 元素可能仍挂着上一首歌的 src/metadata，
			// 若无视之直接按其 src 下载，会把"上一首的音频 + 当前歌词"错配发给后端
			// （表现为：音频是旧的、歌词是新的）。此处借 getPlaying().dt 这把稳尺子裁定
			// 音频元素是否已切到新歌；未就位则在限期内耐心等待，其间若检出切歌则中止，
			// 限期届满仍不到位便果断放弃——绝不在旧音频上下手。
			const alignStatus = await waitUntilAudioAligned(expectedSongId, expectedSrc);
			if (alignStatus === 'switched') {
				console.log('[AI Lyric] 等待音频对齐期间检测到切歌，中止本次 AI 处理');
				return { aborted: true };
			}
			if (alignStatus !== 'aligned') {
				console.warn('[AI Lyric] 限定时间内未能确认音频已切到本首歌，为避免新旧错配放弃本次 AI 处理');
				return { audioBlob: null };
			}
			// 【PROBE】门禁通过后将用什么 src 下载
			console.log(
				`[AI Lyric][probe] gate passed, downloading | expectedSongId=${expectedSongId ?? '(null)'} expectedSrc=${expectedSrc ?? '(null)'} | freshAudio.src=${freshAudio?.src ?? '(null)'} freshLocalPath=${freshLocalPath ?? '(null)'}`
			);

			const cacheKey = getAudioCacheKey(freshAudio, freshLocalPath);
			let audioBlob = getCachedAudioBlob(cacheKey);
			if (audioBlob) {
				// 缓存命中：仍需时长校验，防止缓存里存的是旧歌的 blob
				// （切歌时 LibFrontendPlay 可能复用同一 <audio> 元素，src 未变导致 key 命中旧缓存）。
				if (!(await isBlobDurationMatching(audioBlob, freshAudio))) {
					console.warn('[AI Lyric] 缓存音频时长与当前播放歌曲不符，丢弃缓存并重新下载');
					audioBlobCache.delete(cacheKey);
					audioBlob = null;
				} else {
					console.log('[AI Lyric] 命中音频缓存，跳过下载');
					return { audioBlob, cacheKey, audio: freshAudio, localPath: freshLocalPath };
				}
			}

			try {
				if (freshLocalPath) {
					// 本地文件：用 betterncm.fs.readFile 读取完整 Blob
					if (!betterncm?.fs?.readFile) {
						throw new Error('betterncm.fs.readFile 不可用');
					}
					audioBlob = await betterncm.fs.readFile(freshLocalPath);
					if (!audioBlob || audioBlob.size < 1024) {
						throw new Error(`本地音频数据过小 (${audioBlob?.size ?? 0} bytes)，可能不完整`);
					}
				} else {
					// 在线歌曲：fetch 下载完整文件
					// 关键：LibFrontendPlay 的 audio 元素用 Range 请求流式加载，浏览器 HTTP 缓存里
					// 可能存有 206 部分内容。fetch 默认会复用该缓存导致只拿到部分音频，
					// 因此必须 cache: 'no-store' 强制重新下载完整文件，并校验状态码与 Content-Length。
					const res = await fetch(freshAudio.src, { cache: 'no-store' });
					if (!res.ok) throw new Error(`音频下载失败: ${res.status}`);
					// 206 表示只返回了部分内容（复用了 audio 元素的 Range 缓存），视为不完整
					if (res.status === 206) {
						throw new Error('音频下载返回部分内容 (206)，可能不完整');
					}
					const blob = await res.blob();
					// 用 Content-Length 校验完整性：实际大小与声明大小不一致说明下载被截断
					const contentLength = Number(res.headers.get('Content-Length'));
					if (contentLength > 0 && blob.size !== contentLength) {
						throw new Error(`音频数据不完整 (${blob.size}/${contentLength} bytes)`);
					}
					// 简单完整性检查：blob 太小可能是不完整数据
					if (blob.size < 1024) {
						throw new Error(`音频数据过小 (${blob.size} bytes)，可能不完整`);
					}
					audioBlob = blob;
				}
				// 时长校验：确认下载的音频与当前播放歌曲一致（防止切歌竞态下载到旧歌）。
				// 若时长明显不符则视为下载到错误歌曲，抛出异常触发重试（重新获取当前 audio）。
				if (!(await isBlobDurationMatching(audioBlob, freshAudio))) {
					throw new Error('音频时长与当前播放歌曲不符，疑似下载到旧歌');
				}
				// 下载/读取成功，写入缓存
				cacheAudioBlob(cacheKey, audioBlob);
				return { audioBlob, cacheKey, audio: freshAudio, localPath: freshLocalPath };
			} catch (e) {
				console.warn(`[AI Lyric] 获取音频失败 (第 ${attempt + 1} 次)`, e);
				if (attempt < 2) {
					await sleep(1500);
					await waitForAudioMetadata(freshAudio, expectedDurationSec, 5000);
				}
			}
		}
		return { audioBlob: null };
	};

	const downloadResult = await downloadWithRetry();
	if (downloadResult.aborted) return null;
	if (!downloadResult.audioBlob) {
		console.warn('[AI Lyric] 多次获取音频失败，跳过 AI 处理');
		return null;
	}
	const audioBlob = downloadResult.audioBlob;
	const cacheKey = downloadResult.cacheKey;
	// 使用下载时最新获取的 audio/localPath（切歌时可能已更新）
	const effectiveAudio = downloadResult.audio;
	const effectiveLocalPath = downloadResult.localPath;

	// 【PROBE】即将发往后端的音频身份与歌词标题
	const probeDecodedDur = await getAudioBlobDuration(audioBlob);
	console.log(
		`[AI Lyric][probe] SENDING to backend | decodedDur=${probeDecodedDur != null ? probeDecodedDur.toFixed(2) + 's' : '(decode-fail)'} | effSrc=${effectiveAudio?.src ?? '(null)'} effLocalPath=${effectiveLocalPath ?? '(null)'} | title="${songTitleProbe()}"`
	);

	// 5. 请求后端，同时获取标准 LRC 和逐字 LRC（带重试）
	//    本地文件用其扩展名作为音频文件名，便于后端识别格式
	const extMatch = effectiveLocalPath ? effectiveLocalPath.match(/\.(\w+)$/) : null;
	const audioFileName = extMatch ? `audio.${extMatch[1]}` : 'audio.bin';
	const songInfo = getSongInfo();

	let result;
	let requestOk = false;
	for (let attempt = 0; attempt < 2 && !requestOk; attempt++) {
		try {
			result = await requestAILyric(audioBlob, originalLyricText, songInfo, times, audioFileName);
			requestOk = true;
		} catch (e) {
			console.warn(`[AI Lyric] 请求后端失败 (第 ${attempt + 1} 次)`, e);
			if (attempt < 1) {
				await sleep(2000);
			}
		}
	}
	if (!requestOk) {
		console.warn('[AI Lyric] 多次请求后端失败，跳过 AI 处理');
		return null;
	}

	// 6. 解析标准 LRC（提供行的结构）和逐字 LRC（提供逐字数据）
	const standardLines = result.standardLrc ? parseStandardLrc(result.standardLrc) : [];
	const enhancedLines = parseEnhancedLrc(result.enhancedLrc);
	if (enhancedLines.length === 0) {
		console.warn('[AI Lyric] 后端返回的逐字歌词为空');
		return null;
	}
	postProcessDynamicLyric(enhancedLines);

	// 调试：输出后端返回的原始 LRC（由设置中的"AI 逐字歌词调试输出"开关控制）
	if (getSetting('ai-lyric-debug', false)) {
		console.log('[AI Lyric] standard_lrc:', result.standardLrc);
		console.log('[AI Lyric] enhanced_lrc:', result.enhancedLrc);
	}

	// 7. 用标准 LRC 重建歌词行结构，逐字数据对齐到标准行
	//    优先使用标准 LRC 行（解决"一行显示多次"的行数不匹配问题），
	//    并保留原歌词的翻译/罗马音字段
	let newLyrics;
	if (standardLines.length > 0) {
		newLyrics = mergeLyrics(standardLines, enhancedLines, lyrics, start);
	} else {
		// 后端未返回标准 LRC 时，退回按行号对应原歌词行
		let contentIdx = start;
		newLyrics = lyrics.map((line, i) => {
			// 原始空行（间奏）保持原样，不消费后端行
			if ((line.originalLyric ?? '').trim().length === 0) return line;
			const idx = contentIdx - start;
			contentIdx++;
			if (idx < 0 || idx >= enhancedLines.length) return line;
			const enhLine = enhancedLines[idx];
			if (!enhLine || !enhLine.words || enhLine.words.length === 0) return line;
			if (isMetadataLine(line.originalLyric)) {
				// 元数据行：设置 1 秒 duration，供其他插件正确显示时长
				return { ...line, duration: 1000 };
			}
			return {
				...line,
				originalLyric: enhLine.words.map((w) => w.word).join('').trim(),
				dynamicLyric: enhLine.words,
				dynamicLyricTime: enhLine.time ?? line.time,
				duration: (enhLine.end ?? enhLine.time ?? line.time) - (enhLine.time ?? line.time),
			};
		});
	}

	// 记录最近一次成功处理的歌曲身份，供 isAudioStale() 检测切歌竞态
	lastProcessedSongId = expectedSongId ?? betterncm?.ncm?.getPlaying?.()?.id ?? null;
	lastProcessedSrc = effectiveLocalPath || effectiveAudio?.src || null;

	// 写入 AI 歌词结果缓存，供同一首歌再次播放时复用
	cacheAILyricResult(aiCacheKey, newLyrics);

	console.log('[AI Lyric] 已应用 AI 逐字歌词');
	return newLyrics;
}
