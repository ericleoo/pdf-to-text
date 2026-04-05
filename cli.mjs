#!/usr/bin/env node
import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import process from 'node:process';
// Use the legacy build in Node environments per pdfjs-dist guidance
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

async function extractTextFromPdf(filePath) {
  const buf = await fs.readFile(filePath);
  // pdfjs-dist expects a plain Uint8Array, not a Node Buffer
  const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  // Resolve file: URLs to pdfjs-dist resources in Node (fonts, cmaps)
  const require = createRequire(import.meta.url);
  const pdfjsPkgPath = require.resolve('pdfjs-dist/package.json');
  const pdfjsDir = path.dirname(pdfjsPkgPath);
  const toDirUrl = (subdir) => {
    const p = path.join(pdfjsDir, subdir);
    let href = pathToFileURL(p).href;
    if (!href.endsWith('/')) href += '/';
    return href;
  };
  const standardFontDataUrl = toDirUrl('standard_fonts');
  const cMapUrl = toDirUrl('cmaps');
  // In Node, avoid spawning a worker by disabling it explicitly
  const loadingTask = pdfjsLib.getDocument({
    data,
    disableWorker: true,
    // Help PDF.js find bundled resources in Node
    standardFontDataUrl,
    cMapUrl,
    cMapPacked: true,
    // Prefer using system fonts when needed
    useSystemFonts: true,
  });
  const pdf = await loadingTask.promise;

  let out = '';
  const numPages = pdf.numPages;
  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    // Join items with spaces; insert newlines when PDF.js signals end-of-line
    const parts = [];
    for (const item of textContent.items) {
      parts.push(item.str);
      if (item.hasEOL) parts.push('\n');
    }
    const pageText = parts.join(' ').replace(/[ \t]+\n/g, '\n').trim();
    out += pageText + (pageNum < numPages ? '\n\n' : '');
  }

  return out;
}

function normalizeInputPattern(input) {
  if (/^[a-zA-Z]:\\/.test(input)) {
    const drive = input[0].toLowerCase();
    return `/mnt/${drive}/${input.slice(3).replaceAll('\\', '/')}`;
  }

  if (input.startsWith('\\\\')) {
    return input.replaceAll('\\', '/');
  }

  return input.replaceAll('\\', '/');
}

async function main() {
  const args = process.argv.slice(2);
  let toStdout = false;
  const patterns = [];
  for (const arg of args) {
    if (arg === '--stdout' || arg === '-s') {
      toStdout = true;
    } else if (!arg.startsWith('-')) {
      patterns.push(normalizeInputPattern(arg));
    }
  }
  if (patterns.length === 0) {
    console.error('Usage: pdf2txt [--stdout|-s] "<glob-pattern-or-path>" [...]');
    console.error('Example: pdf2txt "docs/**/*.pdf"');
    console.error('Example: pdf2txt "C:\\Users\\me\\docs\\file.pdf"');
    console.error('Example: pdf2txt "a.pdf" "b.pdf" "docs/**/*.pdf"');
    console.error('Example: pdf2txt --stdout "docs/**/*.pdf"');
    process.exit(1);
  }

  const files = [...new Set(await fg(patterns, { dot: false, onlyFiles: true, caseSensitiveMatch: false }))];
  if (files.length === 0) {
    console.error('No PDF files found for input:', patterns.join(', '));
    process.exit(2);
  }

  let converted = 0;
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (ext !== '.pdf') continue;

    try {
      const txt = await extractTextFromPdf(file);
      if (toStdout) {
        if (files.length > 1) {
          process.stdout.write(`===== ${file} =====\n`);
        }
        process.stdout.write(txt + (files.length > 1 ? '\n\n' : '\n'));
      } else {
        const outPath = file.slice(0, -ext.length) + '.txt';
        await fs.writeFile(outPath, txt, 'utf8');
        console.log('Wrote', outPath);
      }
      converted++;
    } catch (err) {
      console.error('Failed for', file, '-', err && err.message ? err.message : err);
    }
  }

  if (converted === 0) {
    process.exit(3);
  }
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(99);
});
