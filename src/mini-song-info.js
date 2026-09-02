import './mini-song-info.scss';

const useState = React.useState;
const useEffect = React.useEffect;
const useRef = React.useRef;

export function MiniSongInfo(props) {
	const [title, setTitle] = useState('');
	const [artist, setArtist] = useState('');
	const [album, setAlbum] = useState('');

	const image = props.image;

	useEffect(() => {
		const observer = new MutationObserver(() => {
			if (image.src === album) return;
			if (image.complete) {
				setAlbum(image.src);
			}
		});
		observer.observe(image, { attributes: true, attributeFilter: ['src'] });
		const onload = () => {
			setAlbum(image.src);
		};
		image.addEventListener('load', onload);
		return () => {
			observer.disconnect();
			image.removeEventListener('load', onload);
		}
	}, [image]);

	const infContainer = props.infContainer;
	useEffect(() => {
		const onObverse = () => {
			const title = infContainer.querySelector('.title .name')?.textContent?.trim() ?? '';
			// 优先从 .playfrom > li:first-child 中的 <a> 获取歌手（普通歌曲），
			// 若为空则尝试 <span class="artist">（云盘歌曲的歌手信息在此处）
			let artist = Array.from(infContainer.querySelectorAll('.info .playfrom > li:first-child a')).map(a => a.textContent.trim()).join(' / ');
			if (!artist) {
				const artistSpan = infContainer.querySelector('.info .playfrom .artist');
				if (artistSpan) {
					artist = artistSpan.textContent.trim();
				}
			}
			setTitle(title);
			setArtist(artist);
		};
		onObverse();
		const observer = new MutationObserver(() => {
			onObverse();
		});
		observer.observe(infContainer, { childList: true, subtree: true });
		return () => {
			observer.disconnect();
		}
	} , [infContainer]);

	return (
		<>
			<div className="album">
				<img src={album} alt="" />
			</div>
			<div className="info">
				<div className="title">{title}</div>
				<div className="artist">{artist}</div>
			</div>
		</>
	);
}