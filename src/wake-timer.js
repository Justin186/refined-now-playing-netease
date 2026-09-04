// 防节流定时器（Web Worker 实现）
//
// 背景：网易云窗口最小化/被遮挡时，Chromium（CEF）会把渲染进程标记为"隐藏"，
// 对嵌套层级 >= 5 的 setTimeout 链进行节流（先钳制到 1 秒一次，深度节流后最长
// 1 分钟一次）。AI 歌词处理流水线（等待音频元数据 → 探测端口 → 下载音频 →
// 请求后端）全部由链式 setTimeout 驱动，最小化后会整体停摆，导致：
//   - window.currentLyrics 迟迟不更新，lyrics-updated 事件不派发
//   - 其他插件（如 LyricBar）在后台切歌时拿不到歌词
//   - 对本地 AI 后端的请求被无限推迟
//
// 原理：Web Worker 是独立线程，其内部的 setTimeout 不受页面可见性节流影响。
// 主线程把定时请求 postMessage 给 Worker，Worker 到点后再 postMessage 回来，
// 用消息往返替代主线程被节流的 setTimeout。
//
// 如果 Worker/Blob 不可用（极端环境），自动退回主线程 setTimeout，功能不受影响。

const WORKER_CODE = `
	const timers = new Map();
	self.onmessage = (e) => {
		const { type, id, ms } = e.data || {};
		if (type === 'set') {
			timers.set(id, setTimeout(() => {
				timers.delete(id);
				self.postMessage({ id });
			}, Math.max(0, ms || 0)));
		} else if (type === 'clear') {
			const t = timers.get(id);
			if (t !== undefined) {
				clearTimeout(t);
				timers.delete(id);
			}
		}
	};
`;

let worker = null;
let workerFailed = false;

// 惰性创建 Worker；失败时置 workerFailed 并退回主线程定时器
const getWorker = () => {
	if (worker || workerFailed) return worker;
	try {
		const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
		worker = new Worker(URL.createObjectURL(blob));
		// 统一消息分发：Worker 回报定时器 id，查表调用主线程回调
		worker.onmessage = (e) => {
			const id = e?.data?.id;
			const cb = pendingCallbacks.get(id);
			if (cb) {
				pendingCallbacks.delete(id);
				try {
					cb();
				} catch (err) {
					console.warn('[WakeTimer] 定时回调执行失败', err);
				}
			}
		};
		worker.onerror = (e) => {
			console.warn('[WakeTimer] Worker 出错，后续退回主线程 setTimeout', e?.message ?? e);
			workerFailed = true;
		};
	} catch (e) {
		console.warn('[WakeTimer] 创建 Worker 失败，退回主线程 setTimeout', e);
		workerFailed = true;
	}
	return worker;
};

// 主线程侧回调表：key 为定时器 id
const pendingCallbacks = new Map();
let nextId = 1;

// 不受页面可见性节流影响的 setTimeout。
// 返回定时器 id，可用 clearUnthrottledTimeout 取消。
export const setTimeoutUnthrottled = (callback, ms) => {
	const id = nextId++;
	const w = getWorker();
	if (w) {
		pendingCallbacks.set(id, callback);
		w.postMessage({ type: 'set', id, ms });
	} else {
		// 退回主线程定时器（最小化时可能被节流，但保证功能可用）
		pendingCallbacks.set(id, setTimeout(() => {
			pendingCallbacks.delete(id);
			try {
				callback();
			} catch (err) {
				console.warn('[WakeTimer] 定时回调执行失败', err);
			}
		}, ms));
	}
	return id;
};

// 取消 setTimeoutUnthrottled 创建的定时器
export const clearTimeoutUnthrottled = (id) => {
	if (id == null) return;
	const w = worker; // 注意：不要在这里触发 Worker 创建
	if (w) {
		pendingCallbacks.delete(id);
		w.postMessage({ type: 'clear', id });
	} else {
		const t = pendingCallbacks.get(id);
		// 主线程退回路径里存的本身就是 timeout id
		if (typeof t === 'number') clearTimeout(t);
		pendingCallbacks.delete(id);
	}
};

// 不受节流影响的 sleep，用于重试间隔等场景
export const sleepUnthrottled = (ms) =>
	new Promise((resolve) => setTimeoutUnthrottled(resolve, ms));
