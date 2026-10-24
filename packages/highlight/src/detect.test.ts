import { describe, expect, it } from "vitest";
import { DETECT_SAMPLE_BYTES, detectLanguage } from "./detect.js";
import { DETECTION_SAMPLES, SAMPLES } from "./samples.js";

const id = (content: string, filename?: string) =>
  detectLanguage({ content, filename }).language?.id;

describe("detection from content", () => {
  it("has real samples for at least 20 languages", () => {
    expect(Object.keys(SAMPLES).length).toBeGreaterThanOrEqual(24);
  });

  it.each(Object.entries(DETECTION_SAMPLES))("recognises the %s sample", (language, source) => {
    const result = detectLanguage({ content: source });
    expect(result.language?.id, `${language}: ${result.reason}`).toBe(language);
    expect(result.confidence).toBeGreaterThanOrEqual(0.4);
  });

  it("detects shell and Perl scripts without a shebang", () => {
    expect(id((SAMPLES.shell ?? "").split("\n").slice(1).join("\n"))).toBe("shell");
    expect(id((SAMPLES.perl ?? "").split("\n").slice(1).join("\n"))).toBe("perl");
  });

  it.each([
    ["#!/usr/bin/env python3\nprint('hi')", "python"],
    ["#!/usr/bin/python\nprint 'hi'", "python"],
    ["#!/bin/sh\nls", "shell"],
    ["#!/bin/bash -e\nls", "shell"],
    ["#!/usr/bin/env zsh\nls", "shell"],
    ["#!/usr/bin/env node\nconsole.log(1)", "javascript"],
    ["#!/usr/bin/env -S deno run --allow-net\nconsole.log(1)", "typescript"],
    ["#!/usr/bin/env ruby\nputs 1", "ruby"],
    ["#!/usr/bin/perl -w\nprint 1;", "perl"],
    ["#!/usr/bin/env php\n<?php echo 1;", "php"],
    ["#!/usr/bin/env lua\nprint(1)", "lua"],
    ["#!/usr/bin/env pwsh\nWrite-Host 1", "powershell"],
    ["#!/usr/bin/env Rscript\nprint(1)", "r"],
  ])("reads the shebang of %j", (content, expected) => {
    const result = detectLanguage({ content });
    expect(result.language?.id).toBe(expected);
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    expect(result.reason).toMatch(/shebang/);
  });

  it.each([
    ["<?php\necho 1;", "php"],
    ['<?xml version="1.0"?>\n<a/>', "xml"],
    ["<!DOCTYPE html>\n<p>x</p>", "html"],
    ['<svg xmlns="http://www.w3.org/2000/svg"></svg>', "xml"],
    ['{"a": [1, 2, {"b": null}]}', "json"],
    ["[1, 2, 3]", "json"],
    ["FROM alpine\nRUN apk add curl", "dockerfile"],
    ["# base image\nFROM node:22 AS build\n", "dockerfile"],
    ["diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b", "diff"],
  ])("recognises the marker in %j", (content, expected) => {
    expect(id(content)).toBe(expected);
  });

  it("separates TypeScript from JavaScript and JSX from TSX", () => {
    expect(id("const add = (a, b) => a + b;\nconsole.log(add(1, 2));")).toBe("javascript");
    expect(
      id("const add = (a: number, b: number): number => a + b;\ninterface P { x: number }"),
    ).toBe("typescript");
    expect(id(SAMPLES.jsx ?? "")).toBe("jsx");
    expect(id(SAMPLES.tsx ?? "")).toBe("tsx");
  });

  it("separates C from C++ and Kotlin from Java", () => {
    expect(id(SAMPLES.c ?? "")).toBe("c");
    expect(id(SAMPLES.cpp ?? "")).toBe("cpp");
    expect(id(SAMPLES.kotlin ?? "")).toBe("kotlin");
    expect(id(SAMPLES.java ?? "")).toBe("java");
  });

  it("does not guess on prose, tiny or empty input", () => {
    expect(detectLanguage({ content: "" }).language).toBeUndefined();
    expect(detectLanguage({ content: "   \n\n" }).language).toBeUndefined();
    expect(detectLanguage({ content: "hello world" }).language).toBeUndefined();
    expect(
      detectLanguage({
        content:
          "Please select the best option from the list below, and then update the notes where needed. We will meet on Friday to go over everything.",
      }).language,
    ).toBeUndefined();
    expect(detectLanguage({ content: "x" }).confidence).toBe(0);
  });

  it("offers alternatives and a confidence", () => {
    const result = detectLanguage({ content: SAMPLES.python ?? "" });
    expect(result.alternatives[0]?.language.id).toBe("python");
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.confidence).toBeLessThan(0.9);
  });

  it("stays fast on 5MB of text", () => {
    const source = SAMPLES.python ?? "";
    const big = source.repeat(Math.ceil((5 * 1024 * 1024) / source.length));
    expect(big.length).toBeGreaterThan(5 * 1024 * 1024);
    const start = performance.now();
    const result = detectLanguage({ content: big });
    const elapsed = performance.now() - start;
    expect(result.language?.id).toBe("python");
    expect(elapsed).toBeLessThan(500);
    expect(DETECT_SAMPLE_BYTES).toBe(65536);
  });
});

describe("detection from file names", () => {
  it.each([
    ["main.go", "go"],
    ["index.ts", "typescript"],
    ["default.nix", "nix"],
    ["Counter.sol", "solidity"],
    ["lib.ex", "elixir"],
    ["main.tf", "terraform"],
    ["schema.graphql", "graphql"],
    ["query.promql", "promql"],
    ["src.astro", "astro"],
    ["query.groq", "groq"],
    ["shader.wgsl", "wgsl"],
    ["grammar.pegjs", "pegjs"],
    ["BUILD.bazel", "starlark"],
    ["Sketch.ino", "arduino"],
    ["build.gradle.kts", "gradle-kotlin"],
    [".github/workflows/ci.yml", "github-actions"],
    ["site.ansible.yml", "ansible"],
    ["deployment.k8s.yaml", "kubernetes"],
    ["schema.schema.json", "json-schema"],
    ["src/app.component.html", "angular"],
    ["Dockerfile", "dockerfile"],
    ["Gemfile", "ruby"],
    ["x.kt", "kotlin"],
    ["notes.txt", "plaintext"],
  ])("trusts %s", (filename, expected) => {
    const result = detectLanguage({ filename, content: "anything" });
    expect(result.language?.id).toBe(expected);
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("works with a file name and no content", () => {
    expect(detectLanguage({ filename: "a.rs", content: "" }).language?.id).toBe("rust");
  });

  it("falls back to content for unknown extensions", () => {
    expect(id(SAMPLES.python ?? "", "snippet.zzz")).toBe("python");
    expect(id(SAMPLES.go ?? "", "paste")).toBe("go");
  });

  it("settles .h by content: C, C++ or Objective-C", () => {
    expect(id(SAMPLES.c ?? "", "list.h")).toBe("c");
    expect(id(SAMPLES.cpp ?? "", "list.h")).toBe("cpp");
    expect(id("#import <Foundation/Foundation.h>\n@interface Foo : NSObject\n@end", "foo.h")).toBe(
      "objective-c",
    );
    expect(id("", "empty.h")).toBe("c");
  });

  it("settles .m by content: Objective-C or MATLAB/Octave", () => {
    expect(
      id(
        '#import <Foundation/Foundation.h>\n@implementation Foo\n- (void)run { NSLog(@"x"); }\n@end',
        "foo.m",
      ),
    ).toBe("objective-c");
    expect(id("function y = f(x)\n  y = zeros(3);\n  disp(y)\nend\n", "f.m")).toBe("octave");
  });

  it("treats a Qt .ts translation file as XML and JSX in .js as JSX", () => {
    expect(id('<?xml version="1.0"?>\n<!DOCTYPE TS>\n<TS version="2.1"></TS>', "app.ts")).toBe(
      "xml",
    );
    expect(id(SAMPLES.jsx ?? "", "App.js")).toBe("jsx");
    expect(id("const x = 1;\nmodule.exports = x;", "App.js")).toBe("javascript");
  });
});

describe("detection on independent snippets", () => {
  const snippets: [string, string][] = [
    [
      "python",
      "import os\nimport sys\n\ndef main(argv):\n    path = argv[1] if len(argv) > 1 else '.'\n    for name in os.listdir(path):\n        if name.endswith('.py'):\n            print(name)\n    return 0\n\nsys.exit(main(sys.argv))",
    ],
    [
      "javascript",
      "const express = require('express');\nconst app = express();\n\napp.get('/', (req, res) => {\n  res.send('ok');\n});\n\napp.listen(3000, () => console.log('up'));",
    ],
    [
      "typescript",
      "export type Handler = (event: Event) => void;\n\nexport class Bus {\n  private handlers: Handler[] = [];\n  on(h: Handler): void {\n    this.handlers.push(h);\n  }\n}",
    ],
    [
      "java",
      'package org.demo;\n\nimport java.util.ArrayList;\n\npublic class Main {\n    public static void main(String[] args) {\n        ArrayList<String> names = new ArrayList<>();\n        names.add("a");\n        System.out.println(names.size());\n    }\n}',
    ],
    [
      "go",
      'package server\n\nimport "log"\n\nfunc Run(addr string) error {\n\tconn, err := listen(addr)\n\tif err != nil {\n\t\tlog.Printf("listen: %v", err)\n\t\treturn err\n\t}\n\tdefer conn.Close()\n\treturn nil\n}',
    ],
    [
      "rust",
      'use std::fs;\n\nfn read(path: &str) -> Result<String, std::io::Error> {\n    let text = fs::read_to_string(path)?;\n    Ok(text)\n}\n\nfn main() {\n    match read("a.txt") {\n        Ok(t) => println!("{}", t),\n        Err(e) => eprintln!("{}", e),\n    }\n}',
    ],
    [
      "csharp",
      'using System;\n\nnamespace Demo\n{\n    class Program\n    {\n        static void Main(string[] args)\n        {\n            Console.WriteLine("hi");\n        }\n    }\n}',
    ],
    [
      "php",
      "<?php\n\nfunction total(array $items): float {\n    $sum = 0;\n    foreach ($items as $item) {\n        $sum += $item['price'];\n    }\n    return $sum;\n}",
    ],
    [
      "ruby",
      'class User < ApplicationRecord\n  has_many :posts\n\n  def full_name\n    "#{first} #{last}"\n  end\nend',
    ],
    ["sql", "select id, name from users where active = 1 order by name;"],
    [
      "sql",
      "INSERT INTO users (id, name) VALUES (1, 'kim');\nUPDATE users SET name = 'lee' WHERE id = 1;",
    ],
    [
      "html",
      '<div class="box">\n  <ul>\n    <li><a href="/a">A</a></li>\n    <li><a href="/b">B</a></li>\n  </ul>\n</div>',
    ],
    [
      "css",
      "body {\n  margin: 0;\n  font-family: sans-serif;\n}\n\n.nav a:hover {\n  color: red;\n}",
    ],
    [
      "yaml",
      "name: ci\non:\n  push:\n    branches: [main]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: pnpm test",
    ],
    [
      "markdown",
      "# Title\n\nSome *text* with a [link](https://example.com) and a list:\n\n- one\n- two\n\n1. first\n2. second",
    ],
    [
      "kotlin",
      'fun main() {\n    val names = listOf("a", "b")\n    names.forEach { println(it) }\n}',
    ],
    [
      "swift",
      'import Foundation\n\nfunc add(_ a: Int, _ b: Int) -> Int {\n    return a + b\n}\n\nlet result = add(1, 2)\nprint("result: \\(result)")',
    ],
    [
      "cpp",
      '#include <string>\n\nnamespace app {\nclass Greeter {\npublic:\n    std::string greet() const { return "hi"; }\n};\n}',
    ],
    [
      "c",
      '#include <stdio.h>\n\nint main(int argc, char **argv) {\n    printf("%d\\n", argc);\n    return 0;\n}',
    ],
    [
      "shell",
      'if [ -f /etc/hosts ]; then\n  echo "found"\nfi\nexport PATH="$PATH:/opt/bin"\nfor f in *.txt; do\n  cat "$f"\ndone',
    ],
  ];

  it.each(snippets)("recognises an unseen %s snippet", (expected, source) => {
    const result = detectLanguage({ content: source });
    expect(
      result.language?.id,
      `${expected}: ${result.reason} ${JSON.stringify(result.alternatives.map((a) => [a.language.id, a.score]))}`,
    ).toBe(expected);
  });
});
