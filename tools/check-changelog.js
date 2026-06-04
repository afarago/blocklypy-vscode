#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const changelogPath = path.resolve(__dirname, '..', 'CHANGELOG.md');

function fail(message) {
    console.error(`\nCHANGELOG check failed: ${message}`);
    console.error('Please update the [Unreleased] section in CHANGELOG.md before publishing.\n');
    process.exit(1);
}

const content = fs.readFileSync(changelogPath, 'utf8');
const lines = content.split(/\r?\n/);

const unreleasedHeaderIndex = lines.findIndex((line) =>
    /^##\s+\[Unreleased\]/i.test(line.trim()),
);

if (unreleasedHeaderIndex === -1) {
    fail('Missing "## [Unreleased]" section.');
}

let nextVersionHeaderIndex = lines.length;
for (let i = unreleasedHeaderIndex + 1; i < lines.length; i += 1) {
    if (/^##\s+\[/.test(lines[i].trim())) {
        nextVersionHeaderIndex = i;
        break;
    }
}

const unreleasedBlock = lines.slice(unreleasedHeaderIndex + 1, nextVersionHeaderIndex);
const hasEntry = unreleasedBlock.some((line) => /^-\s+\S+/.test(line.trim()));

if (!hasEntry) {
    fail('The [Unreleased] section is empty. Add at least one bullet item.');
}

console.log('CHANGELOG check passed.');
