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

// 从 LibFrontendPlay 获取当前播放的 <audio> 元素
const getCurrentAudio = () => {
	try {
		const plugin = window.loadedPlugins?.['LibFrontendPlay'];
		if (!plugin || !plugin.enabled) return null;
		const audio = plugin.currentAudioPlayer;
		if (!audio || !audio.src) return null;
		return audio;
	} catch (e) {
		console.warn('[AI Lyric] 获取 LibFrontendPlay 音频失败', e);
		return null;
	}
};

// 等待音频完全缓冲加载好（readyState >= HAVE_ENOUGH_DATA 或 buffered 覆盖整个时长）
// 避免新歌曲刚切换时音频不完整导致后端解析出错
const waitForAudioReady = async (audio, timeoutMs = 30000) => {
	const HAVE_ENOUGH_DATA = 4;
	const isFullyBuffered = () => {
		try {
			if (audio.readyState >= HAVE_ENOUGH_DATA) return true;
			// 检查 buffered 是否覆盖整个时长
			if (audio.duration > 0 && audio.buffered.length > 0) {
				const lastEnd = audio.buffered.end(audio.buffered.length - 1);
				if (lastEnd >= audio.duration - 0.5) return true;
			}
			return false;
		} catch (e) {
			return false;
		}
	};

	// 等待元数据加载（duration 可用）
	if (audio.readyState < 1) {
		await new Promise((resolve) => {
			const onLoaded = () => {
				audio.removeEventListener('loadedmetadata', onLoaded);
				resolve();
			};
			audio.addEventListener('loadedmetadata', onLoaded);
			setTimeout(() => {
				audio.removeEventListener('loadedmetadata', onLoaded);
				resolve();
			}, 5000);
		});
	}

	if (isFullyBuffered()) return true;

	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			cleanup();
			console.warn('[AI Lyric] 等待音频缓冲超时，使用当前缓冲状态继续');
			resolve(false);
		}, timeoutMs);

		const onCanPlayThrough = () => {
			cleanup();
			resolve(true);
		};
		const onProgress = () => {
			if (isFullyBuffered()) {
				cleanup();
				resolve(true);
			}
		};

		const cleanup = () => {
			clearTimeout(timeout);
			audio.removeEventListener('canplaythrough', onCanPlayThrough);
			audio.removeEventListener('progress', onProgress);
		};

		audio.addEventListener('canplaythrough', onCanPlayThrough);
		audio.addEventListener('progress', onProgress);
	});
};

// 把解析后的歌词行拼成带换行的纯文本（仅原文，按时间顺序）
const buildOriginalLyricText = (lyrics) => {
	if (!Array.isArray(lyrics)) return { text: '', times: [] };
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
const requestAILyric = async (audioBlob, originalLyricText, songInfo, times) => {
	const activePort = await findActiveBackendPort();

	const formData = new FormData();
	formData.append('audio', audioBlob, 'audio.bin');
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
		let nextStart = lineStartMatch
			? parseInt(lineStartMatch[1]) * 60 + parseFloat(lineStartMatch[2])
			: null;
		if (nextStart !== null) line.time = Math.round(nextStart * 1000);

		let match;
		wordReg.lastIndex = 0;
		while ((match = wordReg.exec(lineStr)) !== null) {
			// 保留尾空格（trimStart 只去前导空格），以便标记 endsWithSpace 让英文单词间有空格
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
		if (line.words.length > 0) {
			// 行结束时间 = 最后一个词的结束时间
			const lastWord = line.words[line.words.length - 1];
			line.end = lastWord.time + lastWord.duration;
			lines.push(line);
		}
	});
	return lines;
};

// 判断两个相邻英文词之间是否需要插入空格（后端 ESLRC 不包含词间空格）
const shouldInsertSpace = (prev, next) => {
	if (!prev || !next) return false;
	// 中日韩文字之间不加空格
	const CJKRegex = /([\p{Unified_Ideograph}|\u3040-\u309F|\u30A0-\u30FF])/gu;
	if (prev.match(CJKRegex) || next.match(CJKRegex)) return false;
	// 前一个词以字母/数字/闭合标点结尾，后一个词以字母/数字/开放标点开头 → 加空格
	// 注意：后一个词以撇号开头（如 're/'m/'s）表示缩写连读，不加空格
	const prevEndsWord = /[A-Za-z0-9'",.!?;:%>)\]}]$/.test(prev);
	const nextStartsWord = /^[A-Za-z0-9("\[{<`$#]/.test(next);
	return prevEndsWord && nextStartsWord;
};

// 后处理：标记 CJK 字符、空格结尾、英文词间自动补空格（与 liblyric 的 processLyric 逻辑一致）
const postProcessDynamicLyric = (lines) => {
	const CJKRegex = /([\p{Unified_Ideograph}|\u3040-\u309F|\u30A0-\u30FF])/gu;
	for (const line of lines) {
		const dynamic = line.words || [];
		for (let i = 0; i < dynamic.length; i++) {
			const word = dynamic[i];
			if (word?.word?.match(CJKRegex)) word.isCJK = true;
			// 英文单词之间自动补空格：直接把空格写入词文本（供其他插件使用），
			// 同时保留 endsWithSpace 标记（本插件渲染用）
			if (i < dynamic.length - 1) {
				const next = dynamic[i + 1];
				if (shouldInsertSpace(word.word, next.word)) {
					word.word += ' ';
				}
			}
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
		if (!text) continue;
		for (const time of times) {
			lines.push({ time, lyric: text });
		}
	}
	return lines.sort((a, b) => a.time - b.time);
};

// 计算两段文本的相似度（0~1），用于判断标准行是否与原始行匹配
const calcSimilarity = (a, b) => {
	if (!a || !b) return 0;
	a = a.trim();
	b = b.trim();
	if (a === b) return 1;
	if (a.length === 0 || b.length === 0) return 0;
	// 字符集合交集比例
	const setA = new Set(a);
	const setB = new Set(b);
	let common = 0;
	for (const ch of setA) {
		if (setB.has(ch)) common++;
	}
	return common / Math.max(setA.size, setB.size);
};

// 判断是否为元数据行（作詞/作曲/編曲等 Staff 信息），这些行不应被标准 LRC 覆盖文本或附加逐字
const isMetadataLine = (text) => {
	if (!text) return false;
	return /^(作詞|作曲|編曲|作词|作曲|编曲|作詞者|作曲者|編曲者|作词者|作曲者|编曲者|歌詞|歌词|訳詞|译词|翻譯|翻译|原唱|演唱|製作|制作|監製|监制|企劃|企划|出品|发行|發行|原曲|和声|和聲|伴唱|混音|母带|母帶|录音|錄音|制作人|製作人)[:：]/.test(text);
};

// 把逐字歌词行对齐到标准 LRC 行，重建歌词数组
// 以原歌词为基础（保留所有行，包括元数据/间奏），用标准 LRC 修正文本和时间，
// 用增强 LRC 提供逐字数据（dynamicLyric）
const mergeLyrics = (standardLines, enhancedLines, originalLyrics) => {
	return originalLyrics.map((origLine) => {
		// 找时间最接近的标准行（修正文本和时间）
		let stdLine = null;
		let stdDiff = Infinity;
		for (const sl of standardLines) {
			const diff = Math.abs((sl.time ?? 0) - (origLine.time ?? 0));
			if (diff < stdDiff) {
				stdDiff = diff;
				stdLine = sl;
			}
		}
		// 找时间最接近的增强行（逐字数据）
		let best = null;
		let bestDiff = Infinity;
		for (const enhLine of enhancedLines) {
			const diff = Math.abs((enhLine.time ?? 0) - (origLine.time ?? 0));
			if (diff < bestDiff) {
				bestDiff = diff;
				best = enhLine;
			}
		}
		// 保留原歌词所有字段（翻译/罗马音/间奏等）
		const base = { ...origLine };
		// 用标准行修正文本和时间（时间接近、文本相似且非元数据行才覆盖，避免错位/元数据被错误替换）
		if (stdLine && stdDiff < 3000 && !isMetadataLine(origLine.originalLyric) && calcSimilarity(stdLine.lyric, origLine.originalLyric) >= 0.5) {
			base.originalLyric = stdLine.lyric;
			base.time = stdLine.time;
		}
		// 只有匹配到时间接近的逐字行（说明是真正的歌词行）才附加逐字数据
		if (best && best.words && best.words.length > 0 && bestDiff < 3000 && !isMetadataLine(origLine.originalLyric)) {
			base.duration = (best.end ?? best.time ?? base.time) - (best.time ?? base.time);
			base.dynamicLyric = best.words;
			base.dynamicLyricTime = best.time ?? base.time;
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

// 把后端返回的逐字歌词应用到现有歌词行上
// 返回新的歌词数组（替换了 dynamicLyric），失败时返回 null
export async function applyAILyric(lyrics) {
	// 0. 设置中未启用 AI 逐字歌词时直接跳过（不探测端口、不下载音频）
	if (!getSetting('ai-lyric', false)) {
		return null;
	}

	// 1. 没有歌词文本就不处理
	const { text: originalLyricText, times } = buildOriginalLyricText(lyrics);
	if (!originalLyricText) {
		console.log('[AI Lyric] 歌曲没有歌词文本，跳过 AI 处理');
		return null;
	}

	// 2. 获取当前音频
	const audio = getCurrentAudio();
	if (!audio) {
		console.log('[AI Lyric] 未找到 LibFrontendPlay 音频，跳过 AI 处理');
		return null;
	}

	// 3. 等待音频完全缓冲，避免新歌曲音频不完整导致后端解析出错
	await waitForAudioReady(audio);

	// 4. 下载音频 blob（带重试，避免音频未完全就绪导致数据不完整）
	let audioBlob;
	let downloadOk = false;
	for (let attempt = 0; attempt < 3 && !downloadOk; attempt++) {
		try {
			const res = await fetch(audio.src);
			if (!res.ok) throw new Error(`音频下载失败: ${res.status}`);
			const blob = await res.blob();
			// 简单完整性检查：blob 太小可能是不完整数据
			if (blob.size < 1024) {
				throw new Error(`音频数据过小 (${blob.size} bytes)，可能不完整`);
			}
			audioBlob = blob;
			downloadOk = true;
		} catch (e) {
			console.warn(`[AI Lyric] 下载音频失败 (第 ${attempt + 1} 次)`, e);
			if (attempt < 2) {
				// 等待后重试
				await new Promise((r) => setTimeout(r, 1500));
				await waitForAudioReady(audio, 10000);
			}
		}
	}
	if (!downloadOk) {
		console.warn('[AI Lyric] 多次下载音频失败，跳过 AI 处理');
		return null;
	}

	// 5. 请求后端，同时获取标准 LRC 和逐字 LRC（带重试）
	let result;
	let requestOk = false;
	for (let attempt = 0; attempt < 2 && !requestOk; attempt++) {
		try {
			result = await requestAILyric(audioBlob, originalLyricText, getSongInfo(), times);
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
	enhancedLines.forEach((l) => postProcessDynamicLyric([l]));

	// 调试：输出后端返回的原始 LRC，便于排查元数据行/英文空格问题
	console.log('[AI Lyric] standard_lrc:', result.standardLrc);
	console.log('[AI Lyric] enhanced_lrc:', result.enhancedLrc);

	// 7. 用标准 LRC 重建歌词行结构，逐字数据对齐到标准行
	//    优先使用标准 LRC 行（解决"一行显示多次"的行数不匹配问题），
	//    并保留原歌词的翻译/罗马音字段
	let newLyrics;
	if (standardLines.length > 0) {
		newLyrics = mergeLyrics(standardLines, enhancedLines, lyrics);
	} else {
		// 后端未返回标准 LRC 时，退回按时间匹配原歌词行
		newLyrics = lyrics.map((line) => {
			let best = null;
			let bestDiff = Infinity;
			for (const enhLine of enhancedLines) {
				const diff = Math.abs((enhLine.time ?? 0) - (line.time ?? 0));
				if (diff < bestDiff) {
					bestDiff = diff;
					best = enhLine;
				}
			}
			if (best && best.words && best.words.length > 0 && !isMetadataLine(line.originalLyric)) {
				return {
					...line,
					originalLyric: best.words.map((w) => w.word).join('').trim(),
					dynamicLyric: best.words,
					dynamicLyricTime: best.time ?? line.time,
					duration: (best.end ?? best.time ?? line.time) - (best.time ?? line.time),
				};
			}
			return line;
		});
	}

	console.log('[AI Lyric] 已应用 AI 逐字歌词');
	return newLyrics;
}
