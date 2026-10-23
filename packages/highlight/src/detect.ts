/*
 * Language detection from a file name and the pasted text. No model: a file name, a shebang or a
 * strong marker decides first; otherwise every language scores a handful of weighted signatures and
 * the best one wins if it is clearly ahead. When nothing is convincing the result is `undefined`
 * (plain text) rather than a confident wrong guess.
 */
import { findLanguage, type LanguageEntry, languagesForFilename } from "./languages.js";

export interface DetectInput {
  filename?: string | undefined;
  content: string;
}

export interface Detection {
  /** `undefined` means "plain text": nothing was convincing. */
  readonly language: LanguageEntry | undefined;
  /** 0–1. ≥0.9 filename/shebang/marker, 0.5–0.9 scored, 0 for no answer. */
  readonly confidence: number;
  readonly reason: string;
  /** Best scored candidates (content scoring only), strongest first. */
  readonly alternatives: readonly { language: LanguageEntry; score: number }[];
}

/** Only the start of a document is inspected, so detection stays fast on 5MB pastes. */
export const DETECT_SAMPLE_BYTES = 64 * 1024;
const MIN_SCORE = 5;

type Signature = readonly [pattern: RegExp, weight: number, cap?: number];

const sig = (pattern: RegExp, weight: number, cap = 3): Signature => [pattern, weight, cap];

// Patterns are tested per document with the `g` flag; keep them free of nested quantifiers.
const JS_BASE: Signature[] = [
  sig(/\b(?:const|let|var) [\w$]+\s*=/gm, 2, 4),
  sig(/\bfunction\*? [\w$]*\(/gm, 2, 3),
  sig(/=>/g, 1, 4),
  sig(/\bconsole\.\w+\(/g, 3, 2),
  sig(/\b(?:require\(["']|module\.exports|exports\.\w+ =)/g, 5, 2),
  sig(/^import [^\n]*? from ["'][^"']+["'];?/gm, 4, 2),
  sig(/^export (?:default |const |function |class |async )/gm, 3, 2),
  sig(/===|!==/g, 2, 2),
  sig(/\b(?:document|window)\.\w+/g, 2, 2),
  sig(/\bawait \w+|\basync (?:function|\()/g, 2, 2),
  sig(/\bnew Promise\(|\.then\(|\.map\(|\.filter\(|\.forEach\(/g, 2, 3),
];

const TS_EXTRA: Signature[] = [
  sig(/\b(?:interface|type) [A-Z]\w*(?:<[^>\n]*>)?\s*(?:=|\{)/gm, 6, 2),
  sig(/(?:\)|\w)\s*:\s*(?:string|number|boolean|void|unknown|never|any)\b/g, 5, 4),
  sig(/\)\s*:\s*(?:Promise|Array|Record|Map|Set|Partial)<[^\n]*>\s*(?:=>|\{)/g, 4, 2),
  sig(/\bas (?:const|unknown|any|string|number)\b/g, 4, 2),
  sig(/^import type\b|^export type\b/gm, 8, 2),
  sig(/\benum [A-Z]\w*\s*\{/gm, 5, 1),
  sig(/\b(?:private|public|protected|readonly) \w+\s*[:(]/g, 3, 2),
  sig(/\bimplements \w+|\bdeclare (?:module|const|global)\b/g, 6, 1),
  sig(/<\w+(?:,\s*\w+)*>\(/g, 1, 2),
];

const JSX_EXTRA: Signature[] = [
  sig(/\bclassName=/g, 8, 2),
  sig(/<\/[A-Z]\w*>|<[A-Z]\w*(?:\s+[\w-]+=(?:\{[^}\n]*\}|"[^"\n]*"))*\s*\/>/g, 6, 3),
  sig(/<\/(?:div|span|p|ul|li|button|a|h\d|section|main|header|footer|form)>/g, 4, 3),
  sig(/\breturn \(\s*\n\s*</g, 5, 1),
  sig(/\buse(?:State|Effect|Ref|Memo|Callback)\(/g, 5, 2),
  sig(/from ["']react["']/g, 6, 1),
  sig(/\bonClick=|\bonChange=/g, 5, 1),
];

const SIGNATURES: Record<string, Signature[]> = {
  javascript: JS_BASE,
  typescript: [...JS_BASE.map(([p, w, c]) => [p, w * 0.75, c] as Signature), ...TS_EXTRA],
  python: [
    sig(/^\s*def \w+\([^\n]*\)\s*(?:->[^\n:]+)?:\s*$/gm, 5, 3),
    sig(/^\s*class \w+(?:\([^\n]*\))?:\s*$/gm, 4, 2),
    sig(/^(?:from [\w.]+ import [\w*, ]+|import [\w.]+(?: as \w+)?)\s*$/gm, 4, 3),
    sig(/^if __name__ == ["']__main__["']:/gm, 8, 1),
    sig(/\bself\.\w+/g, 2, 3),
    sig(/^\s*elif\b/gm, 4, 2),
    sig(/^\s*(?:try|else|finally|except[^:\n]*):\s*$/gm, 2, 3),
    sig(/^@\w+(?:\.\w+)*(?:\([^\n]*\))?\s*$/gm, 2, 2),
    sig(/\b(?:None|True|False)\b/g, 1.5, 3),
    sig(/\bprint\(/g, 1, 2),
    sig(/\blen\(|\brange\(|\benumerate\(/g, 2, 2),
    sig(/\bf["'][^"'\n]*\{[^}\n]+\}/g, 3, 2),
    sig(/^\s*(?:for|while) [^\n]*:\s*$/gm, 2, 2),
  ],
  java: [
    sig(/\bSystem\.(?:out|err)\.print/g, 8, 2),
    sig(/^import (?:java|javax|org|com)\.[\w.*]+;/gm, 7, 2),
    sig(/\bpublic static void main\(\s*String/g, 10, 1),
    sig(/@Override\b/g, 3, 2),
    sig(
      /\b(?:public|private|protected) (?:static )?(?:final )?(?:class|interface|enum|record) \w+/g,
      4,
      2,
    ),
    sig(
      /\b(?:public|private|protected) (?:static )?(?:final )?[\w<>[\],]+ \w+\([^)\n]*\)\s*(?:throws \w+\s*)?\{/g,
      3,
      3,
    ),
    sig(/^package [\w.]+;/gm, 3, 1),
    sig(/\bnew \w+(?:<[^>\n]*>)?\(/g, 1, 3),
    sig(/\b(?:String|int|boolean|long|double) \w+ =/g, 1.5, 3),
    sig(/\b(?:List|Map|Set|ArrayList|HashMap)<[\w, <>?]+>/g, 3, 3),
  ],
  kotlin: [
    sig(/\bfun [\w<>.]+\(/g, 5, 3),
    sig(/\b(?:val|var) \w+(?::\s*[\w<>?]+)?\s*=/g, 2, 4),
    sig(/\bdata class\b|\bsealed (?:class|interface)\b|\bcompanion object\b|\blateinit\b/g, 7, 2),
    sig(/^import kotlin[x]?\./gm, 8, 1),
    sig(/\bwhen\s*(?:\([^)\n]*\)\s*)?\{/g, 4, 2),
    sig(/\boverride fun\b/g, 4, 2),
    sig(/\bprintln\(/g, 2, 2),
    sig(/\?\.|\?:|!!\./g, 2, 3),
    sig(/\bfun main\(/g, 5, 1),
    sig(/^package [\w.]+\s*$/gm, 2, 1),
    sig(/\bit\.\w+|\{ it\b/g, 3, 2),
  ],
  swift: [
    sig(/\bfunc \w+(?:<[^>\n]*>)?\(/g, 6, 3),
    sig(/^import (?:Foundation|UIKit|SwiftUI|Combine|AppKit)\b/gm, 9, 1),
    sig(/\bguard [^\n]* else\b/g, 5, 1),
    sig(/\bif let \w+|\bguard let \w+/g, 5, 2),
    sig(/\b(?:let|var) \w+(?:\s*:\s*[\w<>[\]?]+)?\s*=/g, 1.5, 4),
    sig(/\)\s*->\s*[\w<>[\]?]+\s*\{/g, 3, 2),
    sig(/@(?:State|Published|main|objc|ObservedObject|Binding|escaping)\b/g, 6, 2),
    sig(/\b(?:struct|enum|protocol|extension) \w+(?:\s*:\s*[\w, ]+)?\s*\{/g, 4, 2),
    sig(/\bprint\(/g, 1, 2),
    sig(/\bself\.\w+/g, 1, 2),
    sig(/\bnil\b/g, 1, 2),
  ],
  go: [
    sig(/^package \w+\s*$/gm, 3, 1),
    sig(/^import \(\s*$/gm, 6, 1),
    sig(/^func (?:\(\w+ \*?\w+\) )?\w+\(/gm, 7, 3),
    sig(/:=/g, 3, 4),
    sig(/\bfmt\.\w+\(/g, 7, 2),
    sig(/\bif err != nil\b/g, 9, 1),
    sig(/^type \w+ (?:struct|interface) \{/gm, 7, 2),
    sig(/\bdefer \w+|\bgo func\(|\bchan \w+|<-/g, 3, 3),
    sig(/\[\]\w+\{|\bmap\[\w+\]\w+/g, 3, 2),
    sig(/\bnil\b/g, 1, 2),
  ],
  rust: [
    sig(/\bfn \w+(?:<[^>\n]*>)?\(/g, 5, 3),
    sig(/\blet (?:mut )?\w+(?::\s*[\w<>&]+)?\s*=/g, 3, 3),
    sig(/\blet mut\b/g, 5, 1),
    sig(/\bimpl(?:<[^>\n]*>)? (?:\w+ for )?\w+/g, 6, 2),
    sig(/^use [\w:]+(?:::\{[^}\n]*\}|::\*)?;/gm, 5, 2),
    sig(/\b(?:println|print|format|vec|panic|assert_eq|write|todo)!\(/g, 7, 2),
    sig(/\bpub(?:\(crate\))? (?:fn|struct|enum|trait|mod)\b/g, 5, 2),
    sig(/#\[(?:derive|cfg|test|allow)\b/g, 8, 1),
    sig(/\)\s*->\s*(?:Result|Option|Self|&)/g, 4, 2),
    sig(/\b(?:Vec|Option|Result|Box|HashMap)<[^>\n]*>|\bSome\(|\bNone\b|\bOk\(|\bErr\(/g, 3, 3),
    sig(/\bmatch \w+[^\n]*\{/g, 3, 1),
  ],
  c: [
    sig(/^#include <[\w/]+\.h>/gm, 6, 3),
    sig(/^#include "[\w/.]+\.h"/gm, 4, 2),
    sig(/\bint main\(/g, 5, 1),
    sig(/\b(?:printf|scanf|fprintf|sprintf|puts)\(/g, 5, 2),
    sig(/\b(?:malloc|calloc|realloc|free)\(/g, 4, 2),
    sig(/\btypedef (?:struct|enum|union)?\b/g, 4, 2),
    sig(/\bstruct \w+\s*\{/g, 3, 2),
    sig(/^#(?:define|ifdef|ifndef|endif|pragma)\b/gm, 3, 3),
    sig(/\b(?:size_t|uint\d+_t|int\d+_t|unsigned|NULL)\b/g, 2, 3),
    sig(/\bchar \*\*?\w+|\bvoid \*/g, 3, 2),
    sig(/->\w+/g, 1, 2),
  ],
  cpp: [
    sig(/^#include <[a-z_]+>/gm, 8, 3),
    sig(/\bstd::\w+/g, 6, 4),
    sig(/\b(?:cout|cin|cerr|endl)\b/g, 6, 2),
    sig(/\busing namespace\b|\bnamespace \w+/g, 6, 2),
    sig(/\btemplate\s*</g, 7, 2),
    sig(/^\s*(?:public|private|protected):/gm, 5, 2),
    sig(/\b(?:nullptr|constexpr|noexcept|override|virtual)\b/g, 4, 2),
    sig(/\bclass \w+(?:\s*:\s*(?:public|private|protected) \w+)?\s*\{/g, 4, 2),
    sig(/\bauto&?\s*\w+\s*=/g, 3, 2),
    sig(/^#include <[\w/]+\.h>/gm, 2, 2),
    sig(/\bint main\(/g, 2, 1),
  ],
  csharp: [
    sig(/^using System(?:\.\w+)*;/gm, 9, 2),
    sig(/\bConsole\.(?:Write|WriteLine|ReadLine)\(/g, 8, 2),
    sig(/\bnamespace [\w.]+\s*(?:\{|;)/g, 5, 1),
    sig(/\{\s*get;\s*(?:set|init);\s*\}/g, 8, 2),
    sig(
      /\b(?:public|private|internal|protected) (?:static |async |override |sealed |readonly )*[\w<>[\]?]+ \w+\(/g,
      3,
      3,
    ),
    sig(/\bforeach \(/g, 4, 1),
    sig(/\basync Task(?:<[^>\n]*>)?|\bawait \w+/g, 4, 2),
    sig(/\bstring(?:\[\])? \w+|\bvar \w+ =/g, 1.5, 3),
    sig(/^\s*\[\w+(?:\([^\n]*\))?\]\s*$/gm, 3, 2),
    sig(/\bnew [A-Z]\w*(?:<[^>\n]*>)?\(/g, 1, 2),
    sig(/\bLinq\b|\.Select\(|\.Where\(|\.ToList\(\)/g, 4, 2),
  ],
  php: [
    sig(/<\?php\b/g, 25, 1),
    sig(/\$\w+/g, 1.5, 5),
    sig(/\b(?:echo|print) [^\n;]*;/g, 3, 2),
    sig(/\bfunction \w+\([^)\n]*\)[^\n{]*\{/g, 1.5, 2),
    sig(/\$this->\w+/g, 5, 2),
    sig(/^(?:namespace|use) [\w\\]+;/gm, 3, 2),
    sig(/\barray\(|=>\s*\[|\bisset\(|\bempty\(/g, 3, 2),
    sig(/->\w+\(/g, 1, 2),
    sig(/::\w+/g, 1, 2),
  ],
  ruby: [
    sig(/^\s*def \w+[?!=]?(?:\([^)\n]*\))?\s*$/gm, 5, 3),
    sig(/^\s*end\s*$/gm, 3, 4),
    sig(/\bputs [^\n]+/g, 4, 2),
    sig(/^\s*require(?:_relative)? ["']/gm, 4, 2),
    sig(/^\s*(?:class|module) [A-Z]\w*(?: < [\w:]+)?\s*$/gm, 5, 2),
    sig(/\bdo \|[\w, ]+\|/g, 6, 2),
    sig(/\battr_(?:reader|accessor|writer)\b/g, 8, 1),
    sig(/@\w+\s*=|\binitialize\b/g, 3, 2),
    sig(/\.each(?:_with_index)?\b|\.map\s*(?:\{|do)/g, 3, 2),
    sig(/\bunless\b|\belsif\b/g, 4, 2),
    sig(/:\w+\s*=>|\w+:\s+:\w+/g, 3, 2),
    sig(/\bnil\b/g, 1, 2),
  ],
  shell: [
    sig(/^\s*(?:if|elif) \[\[? [^\n]* \]\]?; then\s*$/gm, 6, 2),
    sig(/^\s*fi\s*$|^\s*done\s*$|^\s*esac\s*$/gm, 4, 3),
    sig(/^\s*echo\b/gm, 3, 2),
    sig(/\$\{?\w+\}?/g, 2, 4),
    sig(/\$\([^)\n]+\)/g, 3, 2),
    sig(/^\s*(?:export|source|alias|unset) /gm, 4, 2),
    sig(/\b(?:sudo|apt-get|apt|chmod|chown|mkdir -p|grep -|curl -|wget |tar -|cd )\b/g, 3, 3),
    sig(/^\s*set -[euo]/gm, 6, 1),
    sig(/^\s*for \w+ in [^\n]*; do\s*$/gm, 6, 1),
    sig(/^[A-Z_][A-Z0-9_]*=\S*/gm, 2, 3),
    sig(/\s\|\s|\s&&\s|\s\|\|\s/g, 1, 3),
    sig(/^(?:function \w+|\w+\(\)) ?\{/gm, 4, 2),
  ],
  dockerfile: [
    sig(/^FROM [\w./:@-]+(?: AS \w+)?\s*$/gm, 12, 2),
    sig(
      /^(?:RUN|COPY|ADD|CMD|ENTRYPOINT|EXPOSE|ENV|WORKDIR|ARG|LABEL|USER|VOLUME|HEALTHCHECK) /gm,
      5,
      4,
    ),
  ],
  sql: [
    sig(/\bSELECT\b[^;]{0,300}?\bFROM\b/g, 9, 2),
    sig(/\bselect\s+(?:\*|[\w.]+(?:\s*,\s*[\w.()*]+)*)\s+from\s+\w+/g, 9, 2),
    sig(
      /\bINSERT INTO [\w.]+\s*(?:\(|VALUES|SELECT)|\bUPDATE [\w.]+ SET [\w.]+\s*=|\bDELETE FROM [\w.]+/gi,
      8,
      2,
    ),
    sig(/\bCREATE (?:OR REPLACE )?(?:TABLE|INDEX|VIEW|DATABASE|SCHEMA)\b/gi, 10, 2),
    sig(/\bALTER TABLE [\w.]+|\bDROP TABLE [\w.]+/gi, 8, 1),
    sig(/\b(?:WHERE|GROUP BY|ORDER BY|HAVING|LIMIT)\b/g, 2.5, 4),
    sig(/\b(?:INNER|LEFT|RIGHT|FULL|CROSS)? ?JOIN\b[^;\n]*\bON\b/g, 5, 2),
    sig(/\b(?:PRIMARY KEY|NOT NULL|VARCHAR\(|AUTO_INCREMENT|FOREIGN KEY|REFERENCES)\b/g, 4, 3),
    sig(/\b(?:COUNT|SUM|AVG|MAX|MIN)\(/g, 2, 2),
  ],
  html: [
    sig(/<!doctype html/gi, 25, 1),
    sig(/<html\b/gi, 12, 1),
    sig(/<(?:head|body|meta|title|link|header|footer|nav|main|section|article)\b[^>]*>/gi, 4, 4),
    sig(
      /<(?:div|span|p|a|ul|ol|li|h[1-6]|button|form|input|img|table|tr|td|label|select)\b[^>]*>/gi,
      2,
      5,
    ),
    sig(/<script\b|<style\b/gi, 3, 2),
    sig(/<\/(?:div|span|p|a|ul|li|body|html|head|script|style)>/gi, 1.5, 3),
    sig(/\b(?:class|id|href|src|style)="[^"\n]*"/g, 1, 3),
  ],
  xml: [
    sig(/^\s*<\?xml\b/g, 25, 1),
    sig(/\bxmlns(?::\w+)?=/g, 7, 2),
    sig(/<!\[CDATA\[/g, 6, 1),
    sig(/<([A-Za-z][\w:.-]*)(?:\s+[\w:.-]+="[^"\n]*")*\s*\/>/g, 1.5, 4),
    sig(/<\/[A-Za-z][\w:.-]*>/g, 0.8, 5),
    sig(
      /<(?:project|dependency|configuration|beans|manifest|svg|rss|feed|plist|dict|key)\b/g,
      5,
      2,
    ),
  ],
  css: [
    sig(
      /^\s*(?:color|margin|padding|display|font(?:-[a-z]+)?|background(?:-[a-z]+)?|border(?:-[a-z]+)?|width|height|position|flex(?:-[a-z]+)?|justify-content|align-items|top|left|right|bottom|z-index|overflow|content|text-[a-z]+|line-height|transform|transition|box-shadow|grid(?:-[a-z-]+)?|gap|opacity|cursor)\s*:/gm,
      3,
      6,
    ),
    sig(/@(?:media|import|font-face|keyframes|charset|supports|layer)\b/g, 5, 2),
    sig(/(?:^|[,\s}])[.#][\w-]+\s*(?:[,>+~]\s*[.#:\w-]+\s*)*\{/gm, 3, 3),
    sig(/:(?:hover|focus|active|root|before|after|first-child|nth-child)\b/g, 3, 2),
    sig(/\bvar\(--[\w-]+\)|^\s*--[\w-]+\s*:/gm, 3, 2),
    sig(/\b\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%)\b/g, 1, 3),
  ],
  scss: [
    sig(/^\s*\$[\w-]+\s*:/gm, 7, 2),
    sig(/@(?:mixin|include|use|forward|extend|function|each|if|else)\b/g, 7, 2),
    sig(/^\s*&[:.\-_\w]/gm, 4, 2),
    sig(/#\{[^}\n]+\}/g, 5, 1),
    sig(/\bdarken\(|\blighten\(|\bmath\.\w+\(/g, 4, 1),
    sig(/^\s*(?:color|margin|padding|display|background|border|font-size)\s*:/gm, 1.5, 3),
    sig(/(?:^|[,\s}])[.#][\w-]+\s*\{/gm, 1.5, 2),
  ],
  less: [
    sig(/^\s*@[\w-]+\s*:/gm, 7, 2),
    sig(/\.[\w-]+\(\s*[^)\n]*\)\s*;|\.[\w-]+\s*\([@\w:\s,-]*\)\s*\{/g, 5, 2),
    sig(/~["']/g, 5, 1),
    sig(/^\s*(?:color|margin|padding|display|background|border|font-size)\s*:/gm, 1.5, 3),
    sig(/(?:^|[,\s}])[.#][\w-]+\s*\{/gm, 1.5, 2),
  ],
  yaml: [
    sig(/^---\s*$/gm, 4, 2),
    sig(/^\s*-\s+[\w.-]+:\s/gm, 4, 3),
    sig(/^[\w.-]+:\s*$/gm, 3, 3),
    sig(/^[\w.-]+:\s+\S/gm, 2, 5),
    sig(/^\s*-\s+\S/gm, 1, 3),
    sig(/^\s*#\s/gm, 0.5, 2),
    sig(/[;{}]\s*$/gm, -2, 4),
    sig(
      /^\s*(?:version|services|apiVersion|kind|metadata|name|on|jobs|steps|image|ports)\s*:/gm,
      3,
      3,
    ),
  ],
  toml: [
    sig(/^\[\[?[\w.-]+\]?\]\s*$/gm, 5, 3),
    sig(/^[\w.-]+\s*=\s*(?:"[^"\n]*"|\d+|true|false|\[[^\]\n]*\])\s*$/gm, 3, 4),
    sig(/^\[\[[\w.-]+\]\]\s*$/gm, 5, 1),
  ],
  markdown: [
    sig(/^#{1,6} \S[^\n]*$/gm, 2, 3),
    sig(/^```\w*\s*$/gm, 4, 3),
    sig(/\[[^\]\n]+\]\((?:https?:\/\/|\.{0,2}\/|#)[^)\n]*\)/g, 5, 2),
    sig(/\*\*[^*\n]+\*\*/g, 4, 2),
    sig(/^\s*[-*] \S/gm, 1.5, 4),
    sig(/^\s*\d+\. \S/gm, 1.5, 3),
    sig(/^> \S/gm, 2, 2),
    sig(/^\|.*\|\s*$\n^\|[\s:|-]+\|\s*$/gm, 6, 1),
    sig(/!\[[^\]\n]*\]\([^)\n]+\)/g, 5, 1),
  ],
  lua: [
    sig(/\blocal (?:function )?\w+/g, 5, 3),
    sig(/\bfunction [\w.:]+\([^)\n]*\)/g, 2, 3),
    sig(/\bthen\s*$|\belseif\b/gm, 4, 3),
    sig(/\b(?:ipairs|pairs)\(/g, 7, 2),
    sig(/\bend\)?\s*$/gm, 1.5, 4),
    sig(/~=/g, 5, 1),
    sig(/\brequire\(?\s*["']/g, 2, 1),
    sig(/\bnil\b/g, 1, 2),
    sig(/\.\.(?!\.)/g, 2, 2),
    sig(/^\s*--(?!\[)/gm, 1, 2),
  ],
  haskell: [
    sig(/^module [\w.]+/gm, 6, 1),
    sig(/^import (?:qualified )?[A-Z][\w.]+/gm, 4, 2),
    sig(/^\w+ :: [^\n]+$/gm, 8, 3),
    sig(/\bwhere\s*$/gm, 3, 2),
    sig(/^data [A-Z]\w*[^\n]*=/gm, 6, 1),
    sig(/<-|->/g, 1, 4),
    sig(/\bmain :: IO\b/g, 10, 1),
    sig(/^\s*\|\s+\w+/gm, 2, 2),
    sig(/\$ |\. |\bmap\b|\bfoldr\b/g, 1, 3),
    sig(/\{-|-\}/g, 4, 1),
  ],
  perl: [
    sig(/\bmy [$@%]\w+/g, 7, 3),
    sig(/^use (?:strict|warnings|v?5)\b/gm, 10, 1),
    sig(/=~\s*(?:m|s|tr)?\//g, 6, 2),
    sig(/\bsub \w+\s*\{/g, 6, 2),
    sig(/\$_\b|@_\b|\$\w+\{|\$\w+\[/g, 3, 3),
    sig(/\bprint (?:STDERR |\$\w+ )?["$]/g, 3, 2),
    sig(/\bforeach my\b|\bpackage \w+(?:::\w+)*;/g, 5, 1),
    sig(/\bdie\b|\bunless\b/g, 2, 2),
  ],
  r: [
    sig(/\b\w+\s*<-\s*\S/g, 4, 4),
    sig(/\blibrary\(\w+\)/g, 8, 2),
    sig(/%>%|%in%|%\*%/g, 7, 2),
    sig(/\b(?:data\.frame|ggplot|aes|tibble|dplyr|readRDS|read\.csv)\b/g, 6, 2),
    sig(/\bc\([^)\n]*\)/g, 2, 3),
    sig(/\b(?:TRUE|FALSE|NULL|NA)\b/g, 2, 3),
    sig(/\bfunction\(\w*[^)\n]*\)\s*\{/g, 1.5, 2),
    sig(/\bsummary\(|\bhead\(|\bnrow\(/g, 3, 2),
  ],
  dart: [
    sig(/^import ['"](?:package|dart):/gm, 10, 2),
    sig(/\bvoid main\(\)/g, 4, 1),
    sig(/\bFuture<|\bStream<|\bStatelessWidget\b|\bStatefulWidget\b|\bBuildContext\b/g, 9, 2),
    sig(/@override\b/g, 3, 1),
    sig(/\bfinal \w+ \w+ =/g, 3, 2),
    sig(/\b(?:String|int|double|bool|List<[\w<>]+>) \w+( =|;)/g, 2, 3),
    sig(/\bprint\(/g, 1, 1),
  ],
  scala: [
    sig(/\bobject \w+(?: extends \w+)?\s*\{/g, 6, 1),
    sig(/\bdef \w+(?:\[[^\]\n]*\])?\([^)\n]*\)\s*:\s*[\w[\]]+\s*=/g, 9, 2),
    sig(/\bcase class\b|\bcase object\b|\bsealed trait\b/g, 9, 2),
    sig(/^import scala\./gm, 9, 1),
    sig(/\b(?:val|var) \w+(?::\s*[\w[\]]+)?\s*=/g, 2, 3),
    sig(/\btrait \w+|\bimplicit\b/g, 4, 2),
    sig(/\bmatch\s*\{/g, 5, 1),
  ],
  "objective-c": [
    sig(/^#import\b/gm, 8, 1),
    sig(/@(?:interface|implementation|end|property|selector|protocol|synthesize)\b/g, 8, 3),
    sig(/\bNS[A-Z]\w+/g, 6, 3),
    sig(/\[\[?\w+ (?:alloc|init|new)\]?/g, 5, 2),
    sig(/@"[^"\n]*"/g, 3, 2),
  ],
  powershell: [
    sig(
      /\b(?:Get|Set|New|Remove|Write|Invoke|Start|Stop|Import|Select|Where|ForEach)-[A-Z]\w+/g,
      8,
      3,
    ),
    sig(/\bparam\s*\(/gi, 4, 1),
    sig(/\$_\b|\$PSScriptRoot|\$env:\w+/g, 4, 2),
    sig(/\s-(?:eq|ne|gt|lt|ge|le|like|match|and|or)\s/g, 4, 2),
    sig(/\$\w+\s*=\s*/g, 1, 3),
  ],
  clojure: [
    sig(/\(def(?:n|n-|macro|record|protocol)? [\w*!?-]+/g, 10, 2),
    sig(/\(ns [\w.-]+/g, 10, 1),
    sig(/\(let \[/g, 6, 1),
    sig(/\(:require|\[clojure\./g, 7, 1),
  ],
  scheme: [
    sig(/\(define \(?[\w!?*<>=-]+/g, 9, 2),
    sig(/\(lambda \(/g, 5, 1),
    sig(/\(display |\(newline\)/g, 5, 1),
    sig(/\(let\*? \(\(/g, 5, 1),
  ],
  "common-lisp": [
    sig(/\(defun [\w*-]+/g, 10, 2),
    sig(/\(defvar |\(defparameter |\(defmacro |\(defclass /g, 8, 2),
    sig(/\(format t /g, 6, 1),
    sig(/\(in-package /g, 10, 1),
  ],
  erlang: [
    sig(/^-module\(/gm, 12, 1),
    sig(/^-(?:export|import|define|record|spec)\(/gm, 9, 2),
    sig(/^\w+\([^)\n]*\)\s*(?:when [^\n]+)?->\s*$/gm, 6, 2),
  ],
  julia: [
    sig(/^using \w+/gm, 5, 2),
    sig(/\bfunction \w+\([^)\n]*\)\s*$/gm, 3, 2),
    sig(/@(?:time|inbounds|show|assert|printf)\b/g, 7, 1),
    sig(/::[A-Z]\w+/g, 3, 3),
    sig(/\bprintln\(/g, 2, 1),
    sig(/\b1:\w+|\bend\s*$/gm, 1.5, 3),
  ],
  matlab: [
    sig(/^\s*function [^\n=]*=\s*\w+\(/gm, 8, 1),
    sig(/\b(?:zeros|ones|eye|linspace|disp|fprintf)\(/g, 4, 3),
    sig(/^\s*%/gm, 2, 3),
    sig(/\bend\s*;?\s*$/gm, 1, 3),
  ],
  groovy: [
    sig(/\bdef \w+\s*=/g, 6, 2),
    sig(/\bpipeline\s*\{|\bstage\(/g, 9, 1),
    sig(/\bprintln ["'$\w]/g, 3, 1),
    sig(/\bdependencies\s*\{|\bplugins\s*\{|\bimplementation ['"]/g, 7, 2),
  ],
  vue: [
    sig(/^<template\b/gm, 8, 1),
    sig(/^<script(?: setup)?(?: lang="\w+")?(?: setup)?>/gm, 3, 1),
    sig(/^<style(?: scoped)?(?: lang="\w+")?>/gm, 3, 1),
    sig(/\bv-(?:if|else|for|bind|model|on|show|slot)\b|@click=|:\w+="/g, 6, 3),
    sig(/\bdefineComponent\(|\bdefineProps\b|\bexport default \{/g, 4, 1),
  ],
  svelte: [
    sig(/\{#(?:if|each|await|key)\b|\{:else\b|\{\/(?:if|each|await)\}/g, 10, 2),
    sig(/\bon:\w+=|\bbind:\w+=/g, 8, 2),
    sig(/^\s*\$:\s/gm, 7, 1),
    sig(/\{@html\b|<svelte:\w+/g, 8, 1),
    sig(/^<script(?: lang="ts")?>/gm, 2, 1),
    sig(/\bexport let \w+/g, 6, 2),
  ],
  protobuf: [
    sig(/^syntax = "proto[23]";/gm, 25, 1),
    sig(/^message \w+\s*\{/gm, 9, 2),
    sig(/^\s*(?:repeated |optional )?(?:string|int32|int64|bool|bytes|double) \w+ = \d+;/gm, 8, 3),
    sig(/^(?:service|rpc|enum) \w+/gm, 5, 2),
  ],
  diff: [
    sig(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/gm, 12, 2),
    sig(/^diff --git /gm, 12, 1),
    sig(/^(?:---|\+\+\+) \S/gm, 4, 2),
    sig(/^index [0-9a-f]+\.\.[0-9a-f]+/gm, 6, 1),
  ],
  nginx: [
    sig(/^\s*server\s*\{/gm, 6, 1),
    sig(/^\s*(?:location|upstream) [^\n]*\{/gm, 8, 2),
    sig(/\b(?:proxy_pass|server_name|listen \d+|fastcgi_pass|root \/|ssl_certificate)\b/g, 7, 3),
  ],
  latex: [
    sig(/\\documentclass(?:\[[^\]]*\])?\{/g, 15, 1),
    sig(/\\(?:begin|end)\{\w+\}/g, 6, 3),
    sig(/\\(?:usepackage|section|subsection|textbf|emph|cite|ref|label|item)\b/g, 4, 3),
  ],
  vbnet: [
    sig(/\bDim \w+ As \w+/gi, 9, 2),
    sig(/\bEnd (?:Sub|Function|If|Class|Module|Namespace)\b/gi, 8, 2),
    sig(/\b(?:Public|Private) (?:Sub|Function|Class|Module)\b/gi, 6, 2),
    sig(/\bImports System/gi, 9, 1),
  ],
  cmake: [
    sig(/\bcmake_minimum_required\(/gi, 12, 1),
    sig(
      /\b(?:add_executable|add_library|target_link_libraries|find_package|project|set|include_directories)\(/g,
      5,
      3,
    ),
  ],
  verilog: [
    sig(/\bmodule \w+\s*(?:#\([^)]*\))?\s*\(/g, 7, 1),
    sig(/\bendmodule\b/g, 8, 1),
    sig(/\b(?:always @|assign |posedge |negedge |wire |reg )\b/g, 4, 3),
  ],
  vhdl: [
    sig(/\blibrary ieee;/gi, 12, 1),
    sig(/\b(?:entity|architecture) \w+ (?:is|of)\b/gi, 9, 2),
    sig(/\bstd_logic(?:_vector)?\b|\bprocess\s*\(/gi, 6, 2),
  ],
  fortran: [
    sig(/\bimplicit none\b/gi, 10, 1),
    sig(/^\s*program \w+/gim, 6, 1),
    sig(/\bend (?:program|subroutine|function|do|if)\b/gi, 5, 2),
    sig(/\b(?:integer|real|double precision)\s*(?:::|,)/gi, 4, 2),
  ],
  pascal: [
    sig(/^\s*program \w+;/gim, 9, 1),
    sig(/\bbegin\b[\s\S]{0,400}?\bend[;.]/gi, 4, 1),
    sig(/\b(?:var|procedure|writeln)\b/gi, 3, 3),
    sig(/:=/g, 1, 3),
  ],
  cobol: [
    sig(/\bIDENTIFICATION DIVISION\b/g, 15, 1),
    sig(/\b(?:PROCEDURE|DATA|ENVIRONMENT) DIVISION\b/g, 10, 1),
    sig(/\bPIC(?:TURE)? [9XA]\(?\d*\)?/g, 6, 2),
  ],
  sparql: [
    sig(/^PREFIX \w*:\s*</gm, 9, 2),
    sig(/\bSELECT\s+(?:DISTINCT\s+)?\?\w+/g, 9, 1),
    sig(/\bWHERE\s*\{/g, 4, 1),
  ],
  gherkin: [
    sig(/^\s*Feature:/gm, 12, 1),
    sig(/^\s*(?:Scenario(?: Outline)?|Background):/gm, 9, 2),
    sig(/^\s*(?:Given|When|Then|And|But) /gm, 4, 4),
  ],
  elm: [
    sig(/^module [\w.]+ exposing\b/gm, 12, 1),
    sig(/^import [\w.]+ exposing\b/gm, 8, 2),
    sig(/^\w+ : [^\n]+->[^\n]+$/gm, 6, 2),
  ],
  fsharp: [
    sig(/^open [A-Z][\w.]+/gm, 5, 2),
    sig(/\blet (?:rec |mutable |inline )?\w+(?: \w+)* =/g, 4, 3),
    sig(/\|>|\bmatch \w+ with\b/g, 7, 2),
    sig(/printfn "/g, 8, 1),
  ],
  ocaml: [
    sig(/\blet (?:rec )?\w+(?: \w+)* =\s*$/gm, 3, 2),
    sig(/\bmatch \w+ with\b/g, 5, 1),
    sig(/\bPrintf\.printf\b|\bList\.\w+|;;\s*$/gm, 7, 2),
    sig(/^open [A-Z]\w+\s*$/gm, 3, 1),
  ],
  tcl: [
    sig(/\bproc \w+ \{[^}\n]*\} \{/g, 10, 1),
    sig(/\bputs \$?\w+|\bset \w+ /g, 3, 3),
    sig(/\bforeach \w+ \{/g, 4, 1),
  ],
};

const SHEBANG_INTERPRETERS: Record<string, string> = {
  python: "python",
  python2: "python",
  python3: "python",
  pypy: "python",
  pypy3: "python",
  node: "javascript",
  nodejs: "javascript",
  deno: "typescript",
  bun: "javascript",
  tsx: "typescript",
  "ts-node": "typescript",
  ruby: "ruby",
  perl: "perl",
  php: "php",
  bash: "shell",
  sh: "shell",
  zsh: "shell",
  dash: "shell",
  ash: "shell",
  ksh: "shell",
  fish: "shell",
  lua: "lua",
  luajit: "lua",
  rscript: "r",
  pwsh: "powershell",
  powershell: "powershell",
  groovy: "groovy",
  julia: "julia",
  swift: "swift",
  tclsh: "tcl",
  wish: "tcl",
  escript: "erlang",
  ocaml: "ocaml",
  guile: "scheme",
  sbcl: "common-lisp",
  kotlin: "kotlin",
  dart: "dart",
  scala: "scala",
};

/** Marker lines that settle the language without scoring. */
function detectMarker(head: string): { id: string; reason: string } | undefined {
  const text = head.trimStart();
  if (/^<\?php\b/i.test(text) || /^<\?=/.test(text)) return { id: "php", reason: "<?php tag" };
  if (/^<\?xml\b/i.test(text)) return { id: "xml", reason: "XML declaration" };
  if (/^<!doctype html/i.test(text)) return { id: "html", reason: "HTML doctype" };
  if (/^<svg[\s>]/i.test(text)) return { id: "xml", reason: "SVG root element" };
  if (/^(?:diff --git |Index: \S+\n=+\n)/.test(text)) return { id: "diff", reason: "diff header" };
  if (/^\\documentclass\b/.test(text)) return { id: "latex", reason: "\\documentclass" };
  if (/^syntax\s*=\s*"proto[23]"/.test(text))
    return { id: "protobuf", reason: "proto syntax line" };
  if (/^(?:#[^\n]*\n|\s*\n)*FROM [\w./:@${}-]+(?: AS \w+)?[ \t]*(?:\n|$)/.test(text)) {
    return { id: "dockerfile", reason: "FROM instruction" };
  }
  return undefined;
}

function detectShebang(head: string): { id: string; reason: string } | undefined {
  const match = /^#!\s*(\S+)(?:\s+(.*))?/.exec(head);
  if (!match) return undefined;
  const program = (match[1] ?? "").split("/").pop() ?? "";
  let name = program;
  if (program === "env") {
    const args = (match[2] ?? "")
      .split(/\s+/)
      .filter((a) => a && !a.startsWith("-") && !a.includes("="));
    name = args[0] ?? "";
  }
  name = name.toLowerCase();
  const id = SHEBANG_INTERPRETERS[name] ?? SHEBANG_INTERPRETERS[name.replace(/[\d.]+$/, "")];
  return id
    ? { id, reason: `shebang (${program === "env" ? `env ${name}` : program})` }
    : undefined;
}

function looksLikeJson(text: string): boolean {
  const first = text.trimStart()[0];
  if (first !== "{" && first !== "[") return false;
  if (text.length > DETECT_SAMPLE_BYTES)
    return /^\s*[{[]\s*(?:"[^"\n]*"\s*[:,\]}]|[\]}\n{["\d])/.test(text);
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null;
  } catch {
    return false;
  }
}

function countMatches(pattern: RegExp, text: string, cap: number): number {
  pattern.lastIndex = 0;
  let count = 0;
  while (count < cap) {
    const match = pattern.exec(text);
    if (!match) break;
    count++;
    if (match[0] === "") pattern.lastIndex++;
  }
  return count;
}

function scoreLanguage(signatures: readonly Signature[], text: string): number {
  let score = 0;
  for (const [pattern, weight, cap = 3] of signatures) {
    score += weight * countMatches(pattern, text, cap);
  }
  return score;
}

/** Registry ids whose signatures are filed under another key. */
const SIGNATURE_ID: Readonly<Record<string, string>> = { octave: "matlab" };

/** Scores every language that has signatures; JSX/TSX only count when JSX syntax is present. */
export function scoreContent(text: string, only?: readonly string[]): Map<string, number> {
  const scores = new Map<string, number>();
  const wanted = (id: string) => !only || only.includes(id);
  for (const [id, signatures] of Object.entries(SIGNATURES)) {
    if (wanted(id)) scores.set(id, scoreLanguage(signatures, text));
  }
  const jsx = scoreLanguage(JSX_EXTRA, text);
  if (jsx >= 8) {
    const js = scores.get("javascript") ?? scoreLanguage(JS_BASE, text);
    const ts = scores.get("typescript") ?? scoreLanguage(SIGNATURES.typescript ?? [], text);
    // Typed JSX is TSX; JSX without type syntax is JSX. The plain variants lose to their JSX siblings.
    const typed = scoreLanguage(TS_EXTRA, text) >= 6;
    if (typed && wanted("tsx")) scores.set("tsx", ts + jsx);
    if (!typed && wanted("jsx")) scores.set("jsx", js + jsx);
    if (scores.has("javascript")) scores.set("javascript", js * 0.6);
    if (scores.has("typescript")) scores.set("typescript", ts * 0.6);
  }
  return scores;
}

function rank(scores: Map<string, number>): { language: LanguageEntry; score: number }[] {
  const ranked: { language: LanguageEntry; score: number }[] = [];
  for (const [id, score] of scores) {
    const language = findLanguage(id);
    if (language && score > 0) ranked.push({ language, score });
  }
  return ranked.sort((a, b) => b.score - a.score);
}

/** The leader of a scoring round, or `undefined` when it is too weak or too close to the runner-up. */
function fromScores(
  scores: Map<string, number>,
  minScore: number,
  reason: string,
): Detection | undefined {
  const ranked = rank(scores);
  const top = ranked[0];
  if (!top || top.score < minScore) return undefined;
  const second = ranked[1]?.score ?? 0;
  const margin = (top.score - second) / top.score;
  if (margin < 0.12) return undefined;
  const strength = top.score / (top.score + 10);
  const confidence = Math.min(0.89, 0.3 + 0.6 * strength * (0.45 + 0.55 * margin));
  return {
    language: top.language,
    confidence: Math.round(confidence * 100) / 100,
    reason,
    alternatives: ranked.slice(0, 4),
  };
}

const NONE = (reason: string): Detection => ({
  language: undefined,
  confidence: 0,
  reason,
  alternatives: [],
});

function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** File name first; extensions shared by several languages (`.h`, `.m`, `.ts`) are settled by content. */
function detectByFilename(filename: string, head: string): Detection | undefined {
  const candidates = languagesForFilename(filename);
  const first = candidates[0];
  if (!first) return undefined;
  const ext = extensionOf(filename);
  const reason = `file name ${filename}`;
  const exact = (language: LanguageEntry, confidence: number): Detection => ({
    language,
    confidence,
    reason,
    alternatives: [],
  });

  if (ext === "ts" && /^\s*<(?:\?xml|!DOCTYPE TS|TS[\s>])/i.test(head)) {
    const xml = findLanguage("xml");
    if (xml) return exact(xml, 0.85);
  }
  if (ext === "h" || candidates.length > 1) {
    const ids =
      ext === "h" ? ["c", "cpp", "objective-c"] : candidates.map((c) => SIGNATURE_ID[c.id] ?? c.id);
    const decided = fromScores(scoreContent(head, ids), 4, `${reason} + content`);
    if (decided) return { ...decided, confidence: Math.max(decided.confidence, 0.8) };
    return exact(first, 0.7);
  }
  if ((ext === "js" || ext === "mjs" || ext === "cjs") && scoreLanguage(JSX_EXTRA, head) >= 8) {
    const jsx = findLanguage("jsx");
    if (jsx) return exact(jsx, 0.9);
  }
  return exact(first, 0.97);
}

/**
 * Detects the programming language of a file name and/or text.
 * Order: file name → shebang → marker line → valid JSON → content scoring.
 */
export function detectLanguage(input: DetectInput): Detection {
  const head =
    input.content.length > DETECT_SAMPLE_BYTES
      ? input.content.slice(0, DETECT_SAMPLE_BYTES)
      : input.content;

  if (input.filename) {
    const byName = detectByFilename(input.filename, head);
    if (byName) return byName;
  }
  if (head.trim().length === 0) return NONE("empty");

  const shebang = detectShebang(head);
  if (shebang) {
    const language = findLanguage(shebang.id);
    if (language) return { language, confidence: 0.96, reason: shebang.reason, alternatives: [] };
  }

  const marker = detectMarker(head);
  if (marker) {
    const language = findLanguage(marker.id);
    if (language) return { language, confidence: 0.94, reason: marker.reason, alternatives: [] };
  }

  if (looksLikeJson(head)) {
    const language = findLanguage("json");
    if (language) return { language, confidence: 0.93, reason: "valid JSON", alternatives: [] };
  }

  return (
    fromScores(scoreContent(head), MIN_SCORE, "content signatures") ?? NONE("no strong signal")
  );
}
