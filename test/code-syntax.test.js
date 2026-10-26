import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { codeLanguage, codeLineTokens, codeTokens, highlightCodeLines, CODE_SYNTAX_STYLE } from '../public/code-syntax.js';
import { renderInspectorPanel } from '../src/sharing/share-page.js';

const catalog = JSON.parse(fs.readFileSync(new URL('../public/code-syntax.json', import.meta.url), 'utf8'));
// The Mac app's tests (desktop/tests/main.swift) check its tokenizer against the same cases.
const cases = JSON.parse(fs.readFileSync(new URL('./fixtures/code-syntax-cases.json', import.meta.url), 'utf8'));

for (const sample of cases) {
  test(`colours ${sample.file} as the Mac app does: ${sample.about}`, () => {
    // Arrange
    const language = codeLanguage(sample.file);

    // Act
    const tokens = codeTokens(sample.text, language).map((token) => [token.kind, sample.text.slice(token.start, token.end)]);

    // Assert
    assert.deepEqual(tokens, sample.tokens);
  });
}

test('finds a language by file name before extension, ignoring case and folders', () => {
  assert.equal(codeLanguage('/repo/Dockerfile')?.name, 'Dockerfile');
  assert.equal(codeLanguage('Makefile')?.name, 'Makefile');
  assert.equal(codeLanguage('src/App.TSX')?.name, 'JavaScript');
  assert.equal(codeLanguage('C:\\work\\job.PS1')?.name, 'PowerShell');
  assert.equal(codeLanguage('notes.txt'), null);
  assert.equal(codeLanguage('report.docx'), null);
  assert.equal(codeLanguage(''), null);
});

test('gives every extension and file name to one language only', () => {
  const seen = new Map();
  for (const language of catalog.languages) {
    for (const key of [...language.extensions.map((extension) => `.${extension}`), ...(language.fileNames ?? [])]) {
      assert.equal(seen.get(key), undefined, `${key} is claimed by ${seen.get(key)} and ${language.name}`);
      seen.set(key, language.name);
    }
  }
});

test('colours the code languages Lasso indexes', () => {
  const files = ['a.js', 'a.py', 'a.r', 'a.rb', 'a.go', 'a.rs', 'a.java', 'a.c', 'a.cpp', 'a.cs', 'a.swift', 'a.kt',
    'a.sh', 'a.zsh', 'a.sql', 'a.html', 'a.css', 'a.vue', 'a.toml', 'a.ini', 'a.env', 'a.php', 'a.pl', 'a.lua',
    'a.scala', 'a.dart', 'a.ex', 'a.erl', 'a.hs', 'a.clj', 'a.groovy', 'a.jl', 'a.vb', 'a.fs', 'a.ml', 'a.elm',
    'a.zig', 'a.nim', 'a.sol', 'a.ps1', 'a.bat', 'a.graphql', 'a.proto', 'a.tf', 'a.cmake', 'a.mk', 'a.astro',
    'a.yaml', 'a.yml', 'a.json', 'Gemfile', 'Justfile'];
  assert.deepEqual(files.filter((file) => !codeLanguage(file)), []);
});

test('a block comment opened on one line colours the lines it runs on', () => {
  // Arrange
  const language = codeLanguage('a.js');

  // Act
  const lines = codeLineTokens(['let a = 1; /* one', 'two', 'three */ b'], language);

  // Assert
  assert.deepEqual(lines, [
    [{ start: 0, end: 3, kind: 'keyword' }, { start: 4, end: 5, kind: 'variable' }, { start: 8, end: 9, kind: 'number' },
      { start: 11, end: 17, kind: 'comment' }],
    [{ start: 0, end: 3, kind: 'comment' }],
    [{ start: 0, end: 8, kind: 'comment' }],
  ]);
});

test('a string left open stops at the end of its line, so the next line is read afresh', () => {
  const lines = codeLineTokens(['x = "open', 'return 1'], codeLanguage('a.py'));
  assert.deepEqual(lines[1].map((token) => token.kind), ['keyword', 'number']);
});

test('highlighted lines escape the code they colour', () => {
  // Act
  const html = highlightCodeLines(['if (a < b && c) return "<b>";'], 'gate.js');

  // Assert
  assert.equal(html[0], '<span class="code-keyword">if</span> (a &lt; b &amp;&amp; c) <span class="code-keyword">return</span> '
    + '<span class="code-string">&quot;&lt;b&gt;&quot;</span>;');
});

test('prose files are not coloured', () => {
  assert.equal(highlightCodeLines(['if this then that'], 'notes.txt'), null);
});

test('the style colours each kind in light and dark', () => {
  for (const [kind, color] of Object.entries(catalog.colors)) {
    assert.match(CODE_SYNTAX_STYLE, new RegExp(`\\.code-${kind}\\{color:${color.light}`));
    assert.match(CODE_SYNTAX_STYLE, new RegExp(`\\.code-${kind}\\{color:${color.dark}`));
  }
  assert.match(CODE_SYNTAX_STYLE, /@media\(prefers-color-scheme:dark\)/);
});

test('the source inspector colours a code file\'s lines and leaves prose plain', () => {
  // Arrange
  const preview = { kind: 'text', format: 'plain', extracted: false, location: 'Line 2', lines: [
    { value: 'def allow(self):', lineNumber: 1, cited: false },
    { value: '    return True', lineNumber: 2, cited: true },
  ] };

  // Act
  const code = renderInspectorPanel({ source: { label: 'allow', filename: 'ratelimit.py' } }, 'reference', preview);
  const prose = renderInspectorPanel({ source: { label: 'allow', filename: 'notes.txt' } }, 'reference', preview);

  // Assert
  assert.match(code, /<span class="line-content"><span class="code-keyword">def<\/span> <span class="code-variable">allow<\/span>/);
  assert.match(code, /<span class="code-keyword">return<\/span> <span class="code-keyword">True<\/span>/);
  assert.match(code, /\.code-keyword\{color:#9B2393/);
  assert.match(prose, /<span class="line-content">def allow\(self\):<\/span>/);
});
