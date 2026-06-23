#!/usr/bin/env bun
import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import process from 'node:process';
// Use the legacy build in Node environments per pdfjs-dist guidance
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function repeat(char, count) {
  return count > 0 ? char.repeat(count) : '';
}

function trimRight(text) {
  return text.replace(/[ \t]+$/g, '');
}

function collapseExcessBlankLines(text, maxBlankLines = 2) {
  const lines = text.split('\n');
  const out = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line.trim() === '') {
      blankRun += 1;
      if (blankRun <= maxBlankLines) out.push('');
    } else {
      blankRun = 0;
      out.push(line);
    }
  }
  return out.join('\n').replace(/^\n+|\n+$/g, '');
}

function normalizeInputPattern(input) {
  if (/^[a-zA-Z]:\\/.test(input)) {
    return input.replaceAll('\\', '/');
  }

  if (input.startsWith('\\\\')) {
    return input.replaceAll('\\', '/');
  }

  return input.replaceAll('\\', '/');
}

function getPdfjsResourceUrls() {
  const require = createRequire(import.meta.url);
  const pdfjsPkgPath = require.resolve('pdfjs-dist/package.json');
  const pdfjsDir = path.dirname(pdfjsPkgPath);
  const toDirUrl = (subdir) => {
    const p = path.join(pdfjsDir, subdir);
    let href = pathToFileURL(p).href;
    if (!href.endsWith('/')) href += '/';
    return href;
  };
  return {
    standardFontDataUrl: toDirUrl('standard_fonts'),
    cMapUrl: toDirUrl('cmaps'),
  };
}

function toPositionedItems(textContent) {
  return textContent.items
    .filter((item) => typeof item?.str === 'string' && item.str.length > 0 && Array.isArray(item.transform))
    .map((item) => {
      const x = Number(item.transform[4]) || 0;
      const y = Number(item.transform[5]) || 0;
      const width = Math.max(0, Number(item.width) || 0);
      const transformHeight = Math.hypot(Number(item.transform[2]) || 0, Number(item.transform[3]) || 0);
      const height = Math.max(0, Number(item.height) || 0, transformHeight);
      return {
        str: item.str,
        x,
        y,
        width,
        height,
        hasEOL: Boolean(item.hasEOL),
      };
    });
}

function groupItemsIntoLines(items) {
  if (items.length === 0) return [];

  const sorted = [...items].sort((a, b) => {
    if (Math.abs(b.y - a.y) > 0.01) return b.y - a.y;
    return a.x - b.x;
  });

  const heights = sorted.map((item) => item.height).filter((h) => h > 0);
  const medianHeight = median(heights) || 10;
  const yTolerance = clamp(medianHeight * 0.45, 2, 8);

  const lines = [];
  for (const item of sorted) {
    let bestLine = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const line of lines) {
      const distance = Math.abs(line.y - item.y);
      if (distance <= yTolerance && distance < bestDistance) {
        bestLine = line;
        bestDistance = distance;
      }
    }

    if (!bestLine) {
      lines.push({ y: item.y, items: [item] });
      continue;
    }

    bestLine.items.push(item);
    bestLine.y = (bestLine.y * (bestLine.items.length - 1) + item.y) / bestLine.items.length;
  }

  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    line.minX = line.items[0]?.x ?? 0;
    line.maxX = Math.max(...line.items.map((item) => item.x + item.width));
    line.height = Math.max(...line.items.map((item) => item.height || 0), medianHeight);
  }

  lines.sort((a, b) => b.y - a.y);
  return lines;
}

function estimateCharWidth(lines) {
  const widths = [];
  for (const line of lines) {
    for (const item of line.items) {
      const visibleChars = item.str.replace(/\s+/g, '').length;
      if (item.width > 0 && visibleChars > 0) {
        widths.push(item.width / visibleChars);
      }
    }
  }
  return clamp(median(widths) || 5, 2, 20);
}

function estimateLineStep(lines) {
  const steps = [];
  for (let i = 1; i < lines.length; i++) {
    const delta = lines[i - 1].y - lines[i].y;
    if (delta > 0.5) steps.push(delta);
  }
  const heights = lines.map((line) => line.height).filter((h) => h > 0);
  return clamp(median(steps) || median(heights) || 12, 6, 36);
}

function shouldInsertSpace(prevText, nextText) {
  if (!prevText || !nextText) return false;
  if (/\s$/.test(prevText) || /^\s/.test(nextText)) return false;
  if (/^[,.;:!?%)\]\}]/.test(nextText)) return false;
  if (/[(/\[{-]$/.test(prevText)) return false;
  return true;
}

function renderLineText(line, charWidth) {
  let out = '';
  let prevItem = null;

  for (const item of line.items) {
    const text = item.str;
    if (!text) continue;

    if (prevItem) {
      const prevEndX = prevItem.x + prevItem.width;
      const gap = item.x - prevEndX;
      if (gap > charWidth * 0.25 && shouldInsertSpace(out, text)) {
        out += ' ';
      }
    }

    out += text;
    prevItem = item;
  }

  return trimRight(out.replace(/[ \t]{2,}/g, ' '));
}

function renderLineLayout(line, pageMinX, charWidth) {
  let out = '';
  let cursor = 0;
  let prevItem = null;

  for (const item of line.items) {
    const text = item.str;
    if (!text) continue;

    let startCol = Math.max(0, Math.round((item.x - pageMinX) / charWidth));

    if (prevItem) {
      const prevEndX = prevItem.x + prevItem.width;
      const gapCols = Math.round((item.x - prevEndX) / charWidth);
      if (gapCols > 0) {
        startCol = Math.max(startCol, cursor + gapCols);
      } else if (shouldInsertSpace(out, text) && item.x - prevEndX > charWidth * 0.15) {
        startCol = Math.max(startCol, cursor + 1);
      }
    }

    if (startCol > cursor) {
      out += repeat(' ', startCol - cursor);
      cursor = startCol;
    }

    out += text;
    cursor = out.length;
    prevItem = item;
  }

  return trimRight(out);
}

function splitLinesIntoBlocks(lines, lineStep) {
  const blocks = [];
  let current = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (current.length === 0) {
      current.push(line);
      continue;
    }

    const prevLine = current[current.length - 1];
    const gap = prevLine.y - line.y;
    if (gap > lineStep * 1.4) {
      blocks.push({ lines: current, gapFromPrevious: gap });
      current = [line];
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) {
    blocks.push({ lines: current, gapFromPrevious: 0 });
  }

  return blocks;
}

function renderPageFromLines(lines, { preserveLayout }) {
  if (lines.length === 0) return '';

  const lineStep = estimateLineStep(lines);
  const blocks = splitLinesIntoBlocks(lines, lineStep);
  const rendered = [];

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex];
    const blockLines = block.lines;
    const charWidth = estimateCharWidth(blockLines) || estimateCharWidth(lines);
    const blockMinX = Math.min(...blockLines.map((line) => line.minX));

    if (blockIndex > 0) {
      const gap = blocks[blockIndex - 1].lines.at(-1).y - blockLines[0].y;
      const blankLines = preserveLayout
        ? clamp(Math.round(gap / lineStep) - 1, 1, 6)
        : 1;
      for (let i = 0; i < blankLines; i++) rendered.push('');
    }

    for (const line of blockLines) {
      rendered.push(
        preserveLayout
          ? renderLineLayout(line, blockMinX, charWidth)
          : renderLineText(line, charWidth)
      );
    }
  }

  return collapseExcessBlankLines(rendered.join('\n'), preserveLayout ? 4 : 2);
}

async function loadPdf(filePath) {
  const buf = await fs.readFile(filePath);
  const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const { standardFontDataUrl, cMapUrl } = getPdfjsResourceUrls();
  const loadingTask = pdfjsLib.getDocument({
    data,
    disableWorker: true,
    standardFontDataUrl,
    cMapUrl,
    cMapPacked: true,
    useSystemFonts: true,
  });
  return loadingTask.promise;
}

async function extractTextFromPdf(filePath, { preserveLayout = false } = {}) {
  const pdf = await loadPdf(filePath);
  const pages = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const items = toPositionedItems(textContent);
    const lines = groupItemsIntoLines(items);
    const pageText = renderPageFromLines(lines, { preserveLayout });
    pages.push(pageText);
  }

  return preserveLayout
    ? pages.join('\n\f\n')
    : pages.join('\n\n');
}

function printUsage() {
  console.error('Usage: pdf2txt [--stdout|-s] [--layout|-l] "<glob-pattern-or-path>" [...]');
  console.error('Example: pdf2txt "docs/**/*.pdf"');
  console.error('Example: pdf2txt "C:\\Users\\me\\docs\\file.pdf"');
  console.error('Example: pdf2txt --layout "a.pdf" "b.pdf" "docs/**/*.pdf"');
  console.error('Example: pdf2txt --stdout --layout "docs/**/*.pdf"');
}

async function main() {
  const args = process.argv.slice(2);
  let toStdout = false;
  let preserveLayout = false;
  const patterns = [];

  for (const arg of args) {
    if (arg === '--stdout' || arg === '-s') {
      toStdout = true;
    } else if (arg === '--layout' || arg === '-l') {
      preserveLayout = true;
    } else if (!arg.startsWith('-')) {
      patterns.push(normalizeInputPattern(arg));
    }
  }

  if (patterns.length === 0) {
    printUsage();
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
      const txt = await extractTextFromPdf(file, { preserveLayout });
      if (toStdout) {
        if (files.length > 1) {
          process.stdout.write(`===== ${file} =====\n`);
        }
        process.stdout.write(txt + (files.length > 1 ? '\n\n' : '\n'));
      } else {
        const outPath = file.slice(0, -ext.length) + '.txt';
        await fs.writeFile(outPath, txt, 'utf8');
        console.log('Wrote', outPath, preserveLayout ? '(layout mode)' : '');
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

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(99);
});
