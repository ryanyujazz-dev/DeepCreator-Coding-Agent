import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : process.env.DEEPCREATOR_RELEASE_TAG;

if (tag && tag !== `v${packageJson.version}`) {
  throw new Error(`发布标签 ${tag} 与 package.json 版本 v${packageJson.version} 不一致。`);
}

console.log(tag ? `发布版本已确认：${tag}` : `本地打包版本：v${packageJson.version}`);
