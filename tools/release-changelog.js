#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const changelogPath = path.join(repoRoot, 'CHANGELOG.md');
const packageJsonPath = path.join(repoRoot, 'package.json');

const PLACEHOLDER_LINE = '- Prepare next release notes.';

function fail(message) {
    console.error(`\nCHANGELOG release failed: ${message}\n`);
    process.exit(1);
}

function normalizeSection(lines) {
    return lines
        .map((line) => line.replace(/\s+$/g, ''))
        .filter((line) => line.trim().toLowerCase() !== PLACEHOLDER_LINE.toLowerCase())
        .join('\n')
        .trim();
}

const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const version = pkg.version;
if (!version) {
    fail('Missing version in package.json.');
}

const content = fs.readFileSync(changelogPath, 'utf8');
const lines = content.split(/\r?\n/);

const unreleasedHeaderIndex = lines.findIndex((line) =>
    /^##\s+\[Unreleased\]/i.test(line.trim()),
);
if (unreleasedHeaderIndex === -1) {
    fail('Missing "## [Unreleased]" section.');
}

let nextHeaderIndex = lines.length;
for (let i = unreleasedHeaderIndex + 1; i < lines.length; i += 1) {
    if (/^##\s+\[/.test(lines[i].trim())) {
        nextHeaderIndex = i;
        break;
    }
}

const unreleasedBodyLines = lines.slice(unreleasedHeaderIndex + 1, nextHeaderIndex);
const releaseBody = normalizeSection(unreleasedBodyLines);
const hasBullet = releaseBody
    .split(/\r?\n/)
    .some((line) => /^-\s+\S+/.test(line.trim()));

if (!hasBullet) {
    fail('No releasable bullet items found under [Unreleased].');
}

const today = new Date().toISOString().slice(0, 10);
const releaseHeader = `## [${version}] - ${today}`;
const releaseSection = `${releaseHeader}\n\n${releaseBody}`;

const head = lines.slice(0, unreleasedHeaderIndex).join('\n').trimEnd();
const tail = lines.slice(nextHeaderIndex).join('\n').trimStart();

if (tail.includes(releaseHeader)) {
    fail(`Version section already exists: ${releaseHeader}`);
}

const newUnreleased = [
    '## [Unreleased]',
    '',
    '### Changed',
    '',
    PLACEHOLDER_LINE,
].join('\n');

const rebuilt = `${head}\n\n${newUnreleased}\n\n${releaseSection}\n\n${tail}\n`;
fs.writeFileSync(changelogPath, rebuilt, 'utf8');

console.log(`CHANGELOG released: ${releaseHeader}`);
