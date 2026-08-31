// AI 逐字歌词处理模块
// 从 LibFrontendPlay 获取当前播放音频，连同 original 歌词纯文本一起发送到本地
// LRC-Maker AI 后端（默认 http://127.0.0.1:8000），用返回的逐字歌词替换 dynamicLyric。
//
// 后端协议参考 LRC-Maker AI 辅助对齐油猴脚本：
//   - GET  /api/ping   -> { app: "lrc-maker-ai" } 用于端口探测
//   - POST /api/align  -> FormData(audio, lyrics, ti, ar, al)
//                         返回 { code: 200, data: { standard_lrc, enhanced_lrc } }
//   enhanced_lrc 为 ESLRC 逐字格式：行首 [mm:ss.xx] 为行起始，每个词后跟 [mm:ss.xx] 为词结束时间

import { getSetting } from './utils.js';

const AI_BACKEND_START_PORT = 8000;
const AI_BACKEND_MAX_TRIES = 10;

// 音频 Blob 内存缓存：避免同一首歌重复下载浪费流量。
// key 为在线歌曲的 audio.src 或本地文件的 localPath，value 为下载好的完整 Blob。
// 只缓存最近几首，防止内存无限增长。
const audioBlobCache = new Map();
const AUDIO_CACHE_MAX = 5;

// 获取音频缓存 key（在线用 src，本地用 localPath）
const getAudioCacheKey = (audio, localPath) => localPath || audio?.src || null;

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
//   1. 快速路径：若传入的 audio 元素已就绪则直接返回。
//   2. 事件监听：在传入的 audio 上监听 loadedmetadata。
//   3. 轮询兜底：定期重新获取 getCurrentAudio()，防止 LibFrontendPlay 切歌时
//      创建了新的 <audio> 元素导致旧元素永远不会触发 loadedmetadata。
const waitForAudioMetadata = async (audio, timeoutMs = 8000) => {
	// 元数据已就绪（duration 可用）则直接返回
	if (audio.readyState >= 1 && audio.duration > 0) return true;

	return new Promise((resolve) => {
		let resolved = false;
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

		// 监听传入 audio 的 loadedmetadata（快速路径）
		const onLoaded = () => resolveOnce();
		audio.addEventListener('loadedmetadata', onLoaded);

		// 竞态保护：本地文件加载极快，loadedmetadata 可能在添加监听前已触发
		if (audio.readyState >= 1 && audio.duration > 0) {
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
					if (cur.readyState >= 1 && cur.duration > 0) {
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

// 把后端返回的逐字歌词应用到现有歌词行上
// 返回新的歌词数组（替换了 dynamicLyric），失败时返回 null
// expectedSongId/expectedSrc：用于在异步处理期间检测切歌，若已切歌则中止
export async function applyAILyric(lyrics, expectedSongId, expectedSrc) {
	// 0. 设置中未启用 AI 逐字歌词时直接跳过（不探测端口、不下载音频）
	if (!getSetting('ai-lyric', false)) {
		return null;
	}

	// 1. 没有歌词文本就不处理
	const { text: originalLyricText, times, start } = buildOriginalLyricText(lyrics);
	if (!originalLyricText) {
		console.log('[AI Lyric] 歌曲没有歌词文本，跳过 AI 处理');
		return null;
	}

	// 2. 获取当前音频及本地路径
	const { audio, localPath } = getCurrentAudio() ?? {};
	if (!audio) {
		console.log('[AI Lyric] 未找到 LibFrontendPlay 音频，跳过 AI 处理');
		return null;
	}

	// 3. 只等音频元数据就绪（确保 src 已切换到新歌），不等待缓冲完整
	await waitForAudioMetadata(audio);

	// 3.5 重新获取当前音频，确保 src/localPath 已切换到新歌。
	//     切歌瞬间触发本函数时，步骤 2 拿到的 audio.src 可能还是上一首歌的 URL，
	//     若直接用旧 src 计算缓存 key，会命中上一首歌的音频缓存，把旧歌音频发给后端。
	//     等待元数据就绪后 audio.src 已更新为新歌，此时重新读取才能拿到正确的缓存 key。
	const current = getCurrentAudio() ?? {};
	const currentAudio = current.audio ?? audio;
	const currentLocalPath = current.localPath ?? localPath;

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

			const cacheKey = getAudioCacheKey(freshAudio, freshLocalPath);
			let audioBlob = getCachedAudioBlob(cacheKey);
			if (audioBlob) {
				console.log('[AI Lyric] 命中音频缓存，跳过下载');
				return { audioBlob, cacheKey, audio: freshAudio, localPath: freshLocalPath };
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
				// 下载/读取成功，写入缓存
				cacheAudioBlob(cacheKey, audioBlob);
				return { audioBlob, cacheKey, audio: freshAudio, localPath: freshLocalPath };
			} catch (e) {
				console.warn(`[AI Lyric] 获取音频失败 (第 ${attempt + 1} 次)`, e);
				if (attempt < 2) {
					await new Promise((r) => setTimeout(r, 1500));
					await waitForAudioMetadata(freshAudio, 5000);
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

	// 5. 请求后端，同时获取标准 LRC 和逐字 LRC（带重试）
	//    本地文件用其扩展名作为音频文件名，便于后端识别格式
	const extMatch = effectiveLocalPath ? effectiveLocalPath.match(/\.(\w+)$/) : null;
	const audioFileName = extMatch ? `audio.${extMatch[1]}` : 'audio.bin';
	let result;
	let requestOk = false;
	for (let attempt = 0; attempt < 2 && !requestOk; attempt++) {
		try {
			result = await requestAILyric(audioBlob, originalLyricText, getSongInfo(), times, audioFileName);
			requestOk = true;
		} catch (e) {
			console.warn(`[AI Lyric] 请求后端失败 (第 ${attempt + 1} 次)`, e);
			if (attempt < 1) {
				await new Promise((r) => setTimeout(r, 2000));
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

	console.log('[AI Lyric] 已应用 AI 逐字歌词');
	return newLyrics;
}
