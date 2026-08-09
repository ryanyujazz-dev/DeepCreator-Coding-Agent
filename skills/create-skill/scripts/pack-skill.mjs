import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { validateSkill } from "./validate-skill.mjs";

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  };
}

function localHeader(name, data, crc, dateTime) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(dateTime.time, 10);
  header.writeUInt16LE(dateTime.date, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  return header;
}

function centralHeader(name, data, crc, dateTime, offset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(0x0314, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(dateTime.time, 12);
  header.writeUInt16LE(dateTime.date, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(data.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  header.writeUInt32LE(offset, 42);
  return header;
}

const result = validateSkill(process.argv[2] ?? ".");
const output = path.resolve(process.cwd(), process.argv[3] ?? `${result.metadata.name}-${result.manifest.version}.deepcreator-skill`);
const workspace = path.resolve(process.cwd());
if (output !== workspace && !output.startsWith(`${workspace}${path.sep}`)) throw new Error("Output must be inside the current workspace.");
const local = [];
const central = [];
let offset = 0;
for (const relative of result.files) {
  const archiveName = Buffer.from(`${result.metadata.name}/${relative}`, "utf8");
  const data = readFileSync(path.join(result.root, relative));
  const checksum = crc32(data);
  const dateTime = dosDateTime(statSync(path.join(result.root, relative)).mtime);
  const header = localHeader(archiveName, data, checksum, dateTime);
  local.push(header, archiveName, data);
  central.push(centralHeader(archiveName, data, checksum, dateTime, offset), archiveName);
  offset += header.length + archiveName.length + data.length;
}
const centralOffset = offset;
const centralData = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(result.files.length, 8);
end.writeUInt16LE(result.files.length, 10);
end.writeUInt32LE(centralData.length, 12);
end.writeUInt32LE(centralOffset, 16);
writeFileSync(output, Buffer.concat([...local, centralData, end]), { mode: 0o600 });
if (statSync(output).size > MAX_ARCHIVE_BYTES) {
  rmSync(output, { force: true });
  throw new Error("Package exceeds 20 MiB.");
}
const packagedPath = path.relative(process.cwd(), output).replaceAll("\\", "/");
process.stdout.write([
  `Packed ${packagedPath}`,
  "If installation was requested, call the top-level Runtime tool preview_skill_install directly with:",
  JSON.stringify({ source: packagedPath }),
  "Add scope=project for a persistent project, or scope=global for all projects. In a scratch workspace, ask whether the user wants the current temporary task or global installation.",
  "Then pass its installRequest unchanged to the top-level Runtime tool install_skill.",
  "These are not Skill scripts or capabilities. If either tool is unavailable, stop and ask the user to restart or update DeepCreator."
].join("\n") + "\n");
