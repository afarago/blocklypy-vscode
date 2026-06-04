#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const changelogRelativePath = 'CHANGELOG.md';
const packageJsonPath = path.join(repoRoot, 'package.json');

function run(command, { trim = true } = {}) {
    const out = execSync(command, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return trim ? out.trim() : out;
}

function fail(message) {
    console.error(`\nCHANGELOG commit failed: ${message}\n`);
    process.exit(1);
}

const statusOutput = run('git status --porcelain', { trim: false });
if (!statusOutput.trim()) {
    console.log('No uncommitted changes.');
    process.exit(0);
}

const changedPaths = statusOutput
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
        // porcelain v1: "XY PATH" — XY are exactly 2 status chars, then a space, then the path
        // Note: do NOT trim the line; the leading space in " M file" is part of XY.
        const match = line.match(/^.{2} (.+?)(?:\s+->\s+.+)?$/);
        return match ? match[1].replace(/^"|"$/g, '') : '';
    })
    .filter(Boolean);

const onlyChangelogDirty =
    changedPaths.length === 1 &&
    changedPaths[0] === changelogRelativePath;

if (!onlyChangelogDirty) {
    fail(
        `Working directory contains files other than ${changelogRelativePath}: ${changedPaths.join(', ')}`,
    );
}

const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const version = pkg.version || 'unknown';

run(`git add ${changelogRelativePath}`);

try {
    run(`git commit -m "chore(changelog): release ${version}"`);
    console.log(`Committed ${changelogRelativePath} for release ${version}.`);
} catch (error) {
    const stderr = error && error.stderr ? String(error.stderr) : '';
    if (/nothing to commit/i.test(stderr)) {
        console.log('No changelog commit required.');
        process.exit(0);
    }
    throw error;
}
