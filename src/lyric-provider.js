// Trigger lyrics-updated event when lyrics are updated
// Also provide a global variable `currentLyrics` for other scripts to use

import { parseLyric } from './liblyric/index.ts'
import { cyrb53, getSetting } from './utils.js'
import { applyAILyric, getCurrentAudio, isMetadataLine } from './ai-lyric-provider.js'

const preProcessLyrics = (lyrics) => {
	if (!lyrics) return null;
	if (!lyrics.lrc) lyrics.lrc = {};

	const original = (lyrics?.lrc?.lyric ?? '').replace(/\u3000/g, ' ');
	const translation = lyrics?.ytlrc?.lyric ?? lyrics?.ttlrc?.lyric ?? lyrics?.tlyric?.lyric ?? '';
	const roma = lyrics?.yromalrc?.lyric ?? lyrics?.romalrc?.lyric ?? '';
	const dynamic = lyrics?.yrc?.lyric ?? '';
	const approxLines = original.match(/\[(.*?)\]/g)?.length ?? 0;

	const parsed = parseLyric(
		original,
		translation,
		roma,
		dynamic
	);
	if (approxLines - parsed.length > approxLines * 0.7) { // 某些特殊情况（逐字歌词残缺不全）
		return parseLyric(
			original,
			translation,
			roma
		);
	}
	return parsed;
}


const processLyrics = (lyrics) => {
	for (const line of lyrics) {
		if (line.originalLyric == '') {
			line.isInterlude = true;
		}
		if (isMetadataLine(line.originalLyric)) {
			line.isMetadata = true; // 元数据行（作词/作曲/编曲等）：时间线里快速跳过
		}
	}
	// 开头的连续元数据行（作词/作曲/编曲等）重写时间戳为每行 1 秒递增，
	// 使其他插件（如 lyricbar）读取 window.currentLyrics 时与 CD 页的快速跳过显示一致。
	// 第一行保持原始时间作为基准，后续元数据行依次 +1000ms。
	const metadataDisplayDuration = 1000;
	let leadingMetaCount = 0;
	while (leadingMetaCount < lyrics.length && lyrics[leadingMetaCount]?.isMetadata) {
		leadingMetaCount++;
	}
	if (leadingMetaCount > 0) {
		const firstMetaTime = lyrics[0].time ?? 0;
		for (let i = 0; i < leadingMetaCount; i++) {
			lyrics[i].time = firstMetaTime + i * metadataDisplayDuration;
			// 设置 1 秒 duration，使其他插件（如 lyricbar）能正确显示每行 1 秒的时长，
			// 而不是持续到歌曲结尾
			lyrics[i].duration = metadataDisplayDuration;
		}
	}
	/*for (const line of lyrics) {
		if (!line.dynamicLyric) {
			// 拆开每一个 CJK 字符，但是保留英文单词不拆
			// 例: "测试a test" => ["测", "试", "a", "test"]
			line.dynamicLyric = line.originalLyric.replace(/([\p{Unified_Ideograph}|\u3040-\u309F|\u30A0-\u30FF])/gu, ' $1 ').replace(/\s+/g, ' ').trim().split(' ').map((x) => {
				return {
					word: x,
				};
			});
		}
		for (const word of line.dynamicLyric) {
			// 如果是日语浊音符，就合并到前一个单词
			if (word.word === 'ﾞ' || word.word === 'ﾟ') {
				const prevWord = line.dynamicLyric[line.dynamicLyric.indexOf(word) - 1];
				if (prevWord) {
					prevWord.word += word.word;
					if (prevWord.durations) prevWord.durations += word.durations;
					line.dynamicLyric.splice(line.dynamicLyric.indexOf(word), 1);
				}
			}
		}
		// const sentense = line.dynamicLyric.map((x) => x.word).join('');
		// console.log(sentense);
	}*/
	return lyrics;
}

// 在开头的连续元数据行（作词/作曲/编曲等）之后插入一个间奏行，
// 使 CD 页的 Interlude 组件（三个点 KTV 倒计时）能显示出来。
// 仅当元数据行后面不是间奏空行（即直接是歌词）时插入；
// 若元数据行后面已有间奏空行，则无需插入（CD 页已能显示三个点）。
const insertInterludeAfterMetadata = (lyrics) => {
	if (!lyrics || lyrics.length === 0) return lyrics;
	let leadingMetaCount = 0;
	while (leadingMetaCount < lyrics.length && lyrics[leadingMetaCount]?.isMetadata) {
		leadingMetaCount++;
	}
	if (leadingMetaCount === 0) return lyrics;
	// 元数据行后面已经是间奏空行，无需插入
	const nextLine = lyrics[leadingMetaCount];
	if (!nextLine || (nextLine.originalLyric ?? '').trim().length === 0) return lyrics;
	// 间奏区间：最后一个元数据行结束 → 下一句歌词开始
	const lastMeta = lyrics[leadingMetaCount - 1];
	const start = (lastMeta?.time ?? 0) + (lastMeta?.duration ?? 1000);
	const end = nextLine.time ?? start;
	if (end <= start) return lyrics; // 无实际间奏时长，不插入
	const interlude = {
		time: start,
		duration: end - start,
		originalLyric: '',
		isInterlude: true,
	};
	lyrics.splice(leadingMetaCount, 0, interlude);
	return lyrics;
};

let currentRawLRC = null;

const _onProcessLyrics = window.onProcessLyrics ?? ((x) => x);
window.onProcessLyrics = (_rawLyrics, songID) => {
	if (!_rawLyrics || _rawLyrics?.data === -400) return _onProcessLyrics(_rawLyrics, songID);

	let rawLyrics = _rawLyrics;
	if (typeof(_rawLyrics) === 'string') { // local lyrics
		rawLyrics = {
			lrc: {
				lyric: _rawLyrics,
			},
			source: {
				name: '本地',
			}
		}
	}

	// 调试：输出 hijack 前的官方 YRC（网易云原始逐字歌词）
	if ((rawLyrics?.lrc?.lyric ?? '') != currentRawLRC) {
		currentRawLRC = (rawLyrics?.lrc?.lyric ?? '') ;
		const preprocessedLyrics = preProcessLyrics(rawLyrics);

		// 在异步处理开始前，同步捕获当前歌曲身份（songID + 音频 src/localPath）。
		// 切歌瞬间触发本回调时，audio.src 可能还是上一首的 URL，因此这里捕获的是
		// "触发本歌词处理时"的歌曲身份，用于在 applyAILyric 的异步处理期间检测切歌，
		// 避免把"上一首的歌词文本 + 当前播放的音频"错配发给后端。
		let expectedSongId = songID;
		let expectedSrc = null;
		try {
			const cur = getCurrentAudio?.() ?? null;
			expectedSrc = cur?.localPath || cur?.audio?.src || null;
		} catch (e) {
			// 忽略，expectedSrc 保持 null（此时仅靠 songID 校验）
		}

		setTimeout(async () => {
			let processedLyrics = await processLyrics(preprocessedLyrics);

			// AI 逐字歌词处理：从 LibFrontendPlay 获取音频，连同歌词文本发送到本地后端，
			// 用返回的逐字歌词替换 dynamicLyric。失败时保留原歌词。
			// 仅在设置中启用时才处理（关闭时不探测端口、不下载音频）
			const aiLyrics = getSetting('ai-lyric', false) ? await applyAILyric(processedLyrics, expectedSongId, expectedSrc) : null;
			if (aiLyrics) {
				processedLyrics = aiLyrics;
			}

			// 在元数据行后插入间奏行，使 CD 页能显示三个点（KTV 倒计时）间奏动画
			processedLyrics = insertInterludeAfterMetadata(processedLyrics);

			const lyrics = {
				lyrics: processedLyrics,
				contributors: {}
			}

			if (processedLyrics[0]?.unsynced) {
				lyrics.unsynced = true;
			}

			if (rawLyrics?.lyricUser) {
				lyrics.contributors.original = {
					name: rawLyrics.lyricUser.nickname,
					userid: rawLyrics.lyricUser.userid,
				}
			}
			if (rawLyrics?.transUser) {
				lyrics.contributors.translation = {
					name: rawLyrics.transUser.nickname,
					userid: rawLyrics.transUser.userid,
				}
			}
			lyrics.contributors.roles = rawLyrics?.roles ?? [];
			lyrics.contributors.roles = lyrics.contributors.roles.filter(role => {
				if (role.artistMetaList.length == 1 && role.artistMetaList[0].artistName == '无' && role.artistMetaList[0].artistId == 0) {
					return false;
				}
				return true;
			});
			for (let i = 0; i < lyrics.contributors.roles.length; i++) {
				const metaList = JSON.stringify(lyrics.contributors.roles[i].artistMetaList);
				for (let j = i + 1; j < lyrics.contributors.roles.length; j++) {
					if (JSON.stringify(lyrics.contributors.roles[j].artistMetaList) === metaList) {
						lyrics.contributors.roles[i].roleName += `、${lyrics.contributors.roles[j].roleName}`;
						lyrics.contributors.roles.splice(j, 1);
						j--;
					}
				}
			}
			

			if (rawLyrics?.source) {
				lyrics.contributors.lyricSource = rawLyrics.source;
			}
			lyrics.hash = `${betterncm.ncm.getPlaying().id}-${cyrb53(processedLyrics.map((x) => x.originalLyric).join('\\'))}`;
			window.currentLyrics = lyrics;
			document.dispatchEvent(new CustomEvent('lyrics-updated', {detail: window.currentLyrics}));
		}, 0);
	}
	return _onProcessLyrics(_rawLyrics, songID);
}