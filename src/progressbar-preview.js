import './progressbar-preview.scss';
import { getSetting } from './utils.js';

const isFMSession = () => {
	return !document.querySelector(".m-player-fm").classList.contains("f-dn");
}

if (getSetting('enable-progressbar-preview', true)) {
	document.body.classList.add('enable-progressbar-preview');
}


const useState = React.useState;
const useEffect = React.useEffect;
const useRef = React.useRef;


function useRefState(initialValue) {
	const [value, setValue] = useState(initialValue);
	const valueRef = useRef(value);

	const updateValue = (val) => {
		valueRef.current = val;
		setValue(val);
	};

	return [valueRef, value, updateValue];
}

let totalLengthInit = 0;
legacyNativeCmder.appendRegisterCall('Load', 'audioplayer',  (_, info) => {
	totalLengthInit = info.duration * 1000;
});

function formatTime(time) {
	const h = Math.floor(time / 3600);
	const m = Math.floor((time - h * 3600) / 60);
	const s = Math.floor(time - h * 3600 - m * 60);
	return `${h ? `${h}:` : ''}${m < 10 ? `0${m}` : m}:${s < 10 ? `0${s}` : s}`;
}

export function ProgressbarPreview(props) {
	const isCurrentModeSession = () => { // 判断是否在当前模式播放 (普通/FM)
		return props.isFM ? isFMSession() : !isFMSession();
	}

	const [visible, setVisible] = useState(false);

	const xRef = useRef(0), yRef = useRef(0);

	const progressBarRef = useRef(null);
	useEffect(() => {
		progressBarRef.current = props.dom;
	}, []);

	const [_lyrics, lyrics, setLyrics] = useRefState(null);
	const [nonInterludeCount, setNonInterludeCount] = useState(0);

	const hoverPercentRef = useRef(0);
	const [currentLine, setCurrentLine] = useState(0);
	const [currentNonInterludeIndex, setCurrentNonInterludeIndex] = useState(0);
	const [currentTime, setCurrentTime] = useState(0);
	// 元数据行（作词/作曲/编曲等）过完后、下一句歌词开始前的间奏状态：
	// 为 true 时预览显示 ♪，而不是直接跳到下一句歌词
	const [showInterludeAfterMeta, setShowInterludeAfterMeta] = useState(false);
	// 间奏 ♪ 的时间区间（毫秒）：从最后一个元数据行结束到下一句歌词开始
	const [interludeStart, setInterludeStart] = useState(0);
	const [interludeEnd, setInterludeEnd] = useState(0);

	const [_totalLength, totalLength, setTotalLength] = useRefState(totalLengthInit);

	const containerRef = useRef(null);

	const subprogressbarInnerRef = useRef(null);

	const onLyricsUpdate = (e) => {
		if (!isCurrentModeSession()) {
			return;
		}
		if (!e.detail) {
			return;
		}
		setLyrics(e.detail.lyrics);
		setNonInterludeCount(e.detail.lyrics.filter(l => l.originalLyric).length);
	}
	useEffect(() => {
		if (window.currentLyrics) {
			if (!isCurrentModeSession()) {
				return;
			}
			const currentLyrics = window.currentLyrics.lyrics;
			setLyrics(currentLyrics);
			setNonInterludeCount(currentLyrics.filter(l => l.originalLyric).length);
		}
		document.addEventListener('lyrics-updated', onLyricsUpdate);
		return () => {
			document.removeEventListener('lyrics-updated', onLyricsUpdate);
		}
	}, []);


	const onLoad = (_, info) => {
		setTotalLength(info.duration * 1000);
	}
	useEffect(() => {
		legacyNativeCmder.appendRegisterCall('Load', 'audioplayer', onLoad);
		return () => {
			legacyNativeCmder.removeRegisterCall('Load', 'audioplayer', onLoad);
		}
	}, []);

	const updateHoverPercent = () => {
		if (!progressBarRef.current) {
			return;
		}
		const rect = progressBarRef.current.getBoundingClientRect();
		const percent = (xRef.current - rect.left) / rect.width;
		hoverPercentRef.current = percent;
		const currentTime = _totalLength.current * percent;
		setCurrentTime(currentTime);
		if (_lyrics.current) {
			let cur = 0;
			let nonInterludeIndex = 0;
			for (let i = 0; i < _lyrics.current.length; i++) {
				if (_lyrics.current[i].time <= currentTime) {
					cur = i;
					if (_lyrics.current[i].originalLyric) {
						nonInterludeIndex++;
					}
				} else {
					break;
				}
			}
			if (
				cur == _lyrics.current.length - 1 &&
				_lyrics.current[cur].duration &&
				currentTime > _lyrics.current[cur].time + _lyrics.current[cur].duration + 500
			) {
				cur = _lyrics.current.length;
			}
			// 元数据行（作词/作曲/编曲等）快速跳过：悬停时间超过开头的连续元数据行后，
			// 跳到第一个非元数据行（可能是间奏 ♪ 或正常歌词），而不是停留在最后一个元数据行
			let leadingMetaCount = 0;
			while (leadingMetaCount < _lyrics.current.length && _lyrics.current[leadingMetaCount]?.isMetadata) {
				leadingMetaCount++;
			}
			// 局部间奏状态（避免 setState 异步导致本次计算读到旧值）
			let isInterludeState = false;
			let interludeStartLocal = 0;
			let interludeEndLocal = 0;
			if (leadingMetaCount > 0) {
				const firstMetaTime = _lyrics.current[0].time ?? 0;
				const elapsed = currentTime - firstMetaTime;
				if (elapsed < leadingMetaCount * 1000) {
					cur = Math.min(Math.floor(elapsed / 1000), leadingMetaCount - 1);
				} else {
					// 元数据行过完后：若下一个非元数据行不是间奏空行，则在下一句歌词开始前
					// 显示 ♪ 间奏；若本身就是间奏空行，循环已正确跳到该行或后续行，无需特殊处理
					const nextLine = _lyrics.current[leadingMetaCount];
					const isNextInterlude = nextLine && (nextLine.originalLyric ?? '').trim().length === 0;
					if (!isNextInterlude) {
						const nextTime = nextLine?.time ?? Infinity;
						if (currentTime < nextTime) {
							// 间奏 ♪ 的时间区间：最后一个元数据行结束 → 下一句歌词开始
							const lastMeta = _lyrics.current[leadingMetaCount - 1];
							interludeStartLocal = (lastMeta?.time ?? 0) + (lastMeta?.duration ?? 1000);
							interludeEndLocal = nextTime;
							isInterludeState = true;
						} else {
							cur = Math.max(cur, leadingMetaCount);
						}
					}
				}
			}
			setShowInterludeAfterMeta(isInterludeState);
			if (isInterludeState) {
				setInterludeStart(interludeStartLocal);
				setInterludeEnd(interludeEndLocal);
			}
			setCurrentLine(cur);
			setCurrentNonInterludeIndex(Math.max(nonInterludeIndex, 1));
			if (subprogressbarInnerRef.current) {
				// 间奏 ♪ 状态下用间奏区间计算进度，否则用当前行区间
				let start = _lyrics.current[cur]?.time;
				let duration = _lyrics.current[cur]?.duration;
				if (isInterludeState) {
					start = interludeStartLocal;
					duration = interludeEndLocal - interludeStartLocal;
				}
				if (duration == 0) {
					duration = _totalLength.current - start;
				}
				subprogressbarInnerRef.current.style.width = (currentTime - start) / duration * 100 + '%';
			}
		}
	};
	const updatePosition = () => {
		if (!containerRef.current) {
			return;
		}
		const width = containerRef.current.clientWidth;
		const height = containerRef.current.clientHeight;
		const rect = progressBarRef.current.getBoundingClientRect();
		let left = xRef.current - width / 2;
		if (left < 0) {
			left = 0;
		}
		if (left + width > window.innerWidth) {
			left = window.innerWidth - width;
		}
		containerRef.current.style.left = left + 'px';
		containerRef.current.style.top = (rect.top - height - 5) + 'px';
	};
	useEffect(() => {
		updatePosition();
	}, [visible, currentLine]);
	

	const onMouseEnter = (e) => {
		setVisible(true);
		xRef.current = e.clientX;
		yRef.current = e.clientY;
		updateHoverPercent();
		updatePosition();
	};
	const onMouseLeave = (e) => {
		setVisible(false);
	};
	const onMouseMove = (e) => {
		xRef.current = e.clientX;
		yRef.current = e.clientY;
		updateHoverPercent();
		updatePosition();
	};
	useEffect(() => {
		if (!progressBarRef.current) {
			return;
		}
		progressBarRef.current.addEventListener('mouseenter', onMouseEnter);
		progressBarRef.current.addEventListener('mouseleave', onMouseLeave);
		progressBarRef.current.addEventListener('mousemove', onMouseMove);
		return () => {
			progressBarRef.current.removeEventListener('mouseenter', onMouseEnter);
			progressBarRef.current.removeEventListener('mouseleave', onMouseLeave);
			progressBarRef.current.removeEventListener('mousemove', onMouseMove);
		}
	}, [progressBarRef.current]);

	
	const isPureMusic = lyrics && (
		lyrics.length === 1 ||
		lyrics.length <= 10 && lyrics.some((x) => (x.originalLyric ?? '').includes('纯音乐')) ||
		document.querySelector('#main-player').getAttribute('data-log')?.includes('"s_ctype":"voice"') ||
		lyrics[0]?.unsynced
	);

	return (
		<div
			ref={containerRef}
			className={`progressbar-preview ${(visible && !isPureMusic) ? '' : 'invisible'}`}
		>
			{
				lyrics && !showInterludeAfterMeta && lyrics[currentLine]?.originalLyric && (
					<div className="progressbar-preview-number">{currentNonInterludeIndex} / {nonInterludeCount}</div>
				)
			}
			{
				lyrics && !showInterludeAfterMeta && lyrics[currentLine]?.dynamicLyric && (
					<div className="progressbar-preview-line-karaoke">
						{
							lyrics[currentLine].dynamicLyric.map((word, i) => {
								const percent = (currentTime - word.time) / word.duration;
								return (<span
									key={i}
									className={`progressbar-preview-line-karaoke-word ${percent >= 0 && percent <= 1 ? 'current' : ''} ${percent <0 ? 'upcoming' : ''}`}
									style={{
										'-webkit-mask-position': `${100 * (1 - Math.max(0, Math.min(1, (currentTime - word.time) / word.duration)))}%`,
									}}
								>
									{word.word}
								</span>);
							})
						}
					</div>
				)
			}
			{
				lyrics && !showInterludeAfterMeta && !lyrics[currentLine]?.dynamicLyric && lyrics[currentLine]?.originalLyric && (
					<div className="progressbar-preview-line-original">{lyrics[currentLine]?.originalLyric}</div>
				)
			}
			{
				lyrics && (showInterludeAfterMeta || lyrics[currentLine]?.originalLyric == '') && (
					<div className="progressbar-preview-line-original">♪</div>
				)
			}
			{
				lyrics && !showInterludeAfterMeta && lyrics[currentLine]?.translatedLyric && (
					<div className="progressbar-preview-line-translated">{lyrics[currentLine]?.translatedLyric}</div>
				)
			}
			{
				lyrics && lyrics[currentLine] && (
					<div className="progressbar-preview-subprogressbar">
						<div className="progressbar-preview-subprogressbar-inner" ref={subprogressbarInnerRef}></div>
					</div>
				)
			}
			{
				lyrics && lyrics[currentLine] && (
					<div className="progressbar-preview-line-time">
						{showInterludeAfterMeta ? (
							<>
								<div>{formatTime(interludeStart / 1000)}</div>
								<div>{formatTime(interludeEnd / 1000)}</div>
							</>
						) : (
							<>
								<div>{formatTime(lyrics[currentLine]?.time / 1000)}</div>
								<div>{lyrics[currentLine]?.duration > 0 ? formatTime((lyrics[currentLine]?.time + lyrics[currentLine]?.duration) / 1000) : formatTime(totalLength / 1000)}</div>
							</>
						)}
					</div>
				)
			}
		</div>
	);
}