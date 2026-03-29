/**
 * 从 public/assets/music/mp3/ 下的 mp3 文件提取 ID3 封面
 * 输出封面到 public/assets/music/cover/
 * 并自动更新 src/_data/music.json
 *
 * 用法: pnpm extract-covers
 */

import * as mm from "music-metadata";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const mp3Dir = path.join(root, "public/assets/music/mp3");
const coverDir = path.join(root, "public/assets/music/cover");
const jsonPath = path.join(root, "src/_data/music.json");

fs.mkdirSync(coverDir, { recursive: true });

const mp3Files = fs
	.readdirSync(mp3Dir)
	.filter((f) => f.toLowerCase().endsWith(".mp3"))
	.sort();

if (mp3Files.length === 0) {
	console.log("没有找到 mp3 文件");
	process.exit(0);
}

const playlist = [];

for (let i = 0; i < mp3Files.length; i++) {
	const file = mp3Files[i];
	const filePath = path.join(mp3Dir, file);
	const baseName = path.basename(file, ".mp3");

	console.log(`处理: ${file}`);

	let title = baseName;
	let artist = "未知艺术家";
	let coverPath = "/assets/music/cover/default.webp";

	try {
		const meta = await mm.parseFile(filePath);
		const tags = meta.common;

		if (tags.title) title = tags.title;
		if (tags.artist) artist = tags.artist;

		// 提取内嵌封面
		const pic = tags.picture?.[0];
		if (pic) {
			const ext = pic.format.includes("png") ? "png" : "jpg";
			const coverFile = `${baseName}.${ext}`;
			const coverFullPath = path.join(coverDir, coverFile);
			fs.writeFileSync(coverFullPath, pic.data);
			coverPath = `/assets/music/cover/${coverFile}`;
			console.log(`  ✓ 提取封面 → ${coverFile}`);
		} else {
			console.log(`  ! 无内嵌封面，使用默认封面`);
		}
	} catch (e) {
		console.error(`  ✗ 读取失败: ${e.message}`);
	}

	playlist.push({
		id: i + 1,
		title,
		artist,
		cover: coverPath,
		url: `/assets/music/mp3/${file}`,
		duration: 0,
	});
}

fs.writeFileSync(jsonPath, JSON.stringify(playlist, null, "\t"), "utf-8");
console.log(`\n✓ 已更新 src/_data/music.json（共 ${playlist.length} 首）`);
