import {
  BUILTIN_TEMPLATE_PREFIX,
  MAX_FILES_PER_SHARE,
  MAX_PATH_LENGTH,
  MAX_TEMPLATE_DESCRIPTION_LENGTH,
  MAX_TEMPLATE_ID_LENGTH,
  MAX_TEMPLATE_NAME_LENGTH,
} from "./constants.js";
import { z } from "./zod.js";

/**
 * Code templates (§9 `GET /api/templates`, §10 `templates`): starting files for a new share.
 * The built-in ones are written for this project; organizations add their own in the settings.
 */

const templateLanguageSchema = z.string().min(1).max(40);

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are rejected on purpose
const CONTROL = /[\u0000-\u001f]/;

/**
 * A relative path that needs no clean-up: the API sanitises paths of new shares, and a template
 * that would change or lose its path there is refused when it is saved instead.
 */
export function isPlainTemplatePath(path: string): boolean {
  if (path === "" || path.length > MAX_PATH_LENGTH || CONTROL.test(path)) return false;
  if (path.includes("\\") || /^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export const templateFileSchema = z.object({
  path: z.string().refine(isPlainTemplatePath, "invalid file path"),
  language: templateLanguageSchema.optional(),
  content: z.string(),
});
export type TemplateFile = z.infer<typeof templateFileSchema>;

const templateFilesSchema = z
  .array(templateFileSchema)
  .min(1)
  .max(MAX_FILES_PER_SHARE)
  .refine((files) => new Set(files.map((file) => file.path)).size === files.length, {
    message: "duplicate file path",
  });

/** A template an admin keeps in the settings. */
export const settingsTemplateSchema = z.object({
  id: z
    .string()
    .max(MAX_TEMPLATE_ID_LENGTH)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
    .refine((id) => !id.toLowerCase().startsWith(BUILTIN_TEMPLATE_PREFIX), {
      message: `ids starting with ${BUILTIN_TEMPLATE_PREFIX} are reserved`,
    }),
  name: z.string().trim().min(1).max(MAX_TEMPLATE_NAME_LENGTH),
  language: templateLanguageSchema,
  description: z.string().trim().max(MAX_TEMPLATE_DESCRIPTION_LENGTH),
  files: templateFilesSchema,
});
export type SettingsTemplate = z.infer<typeof settingsTemplateSchema>;

/** Bytes of the text a template puts into a share, as counted against `settings.maxDocBytes`. */
export function templateBytes(files: readonly { content: string }[]): number {
  const encoder = new TextEncoder();
  return files.reduce((sum, file) => sum + encoder.encode(file.content).length, 0);
}

/**
 * `GET /api/templates` entry. For built-in templates (`builtin: true`) `name` and `description`
 * are i18n keys (`template.<name>.name`); the web app translates them. Organization templates
 * carry the text as typed.
 */
export const templateSchema = z.object({
  id: z.string(),
  name: z.string(),
  language: z.string(),
  description: z.string(),
  files: z.array(templateFileSchema),
  builtin: z.boolean(),
});
export type Template = z.infer<typeof templateSchema>;
export const listTemplatesResponseSchema = z.array(templateSchema);

export interface BuiltinTemplate {
  id: `${typeof BUILTIN_TEMPLATE_PREFIX}${string}`;
  /** i18n key of the name, `template.<slug>.name` */
  nameKey: string;
  /** i18n key of the description, `template.<slug>.description` */
  descriptionKey: string;
  /** Language id of `packages/highlight`; also the default language of the share. */
  language: string;
  files: readonly TemplateFile[];
}

const src = String.raw;
const fence = "`".repeat(3);

function builtin(slug: string, language: string, files: readonly TemplateFile[]): BuiltinTemplate {
  return {
    id: `${BUILTIN_TEMPLATE_PREFIX}${slug}`,
    nameKey: `template.${slug}.name`,
    descriptionKey: `template.${slug}.description`,
    language,
    files,
  };
}

export const BUILTIN_TEMPLATES: readonly BuiltinTemplate[] = [
  builtin("java", "java", [
    {
      path: "Main.java",
      content: src`public class Main {
    public static void main(String[] args) {
        String name = args.length > 0 ? args[0] : "world";
        System.out.println("Hello, " + name + "!");

        int sum = 0;
        for (int i = 1; i <= 10; i++) {
            sum += i;
        }
        System.out.println("1 + 2 + ... + 10 = " + sum);
    }
}
`,
    },
  ]),
  builtin("python", "python", [
    {
      path: "main.py",
      content: src`def greet(name: str) -> str:
    return f"Hello, {name}!"


def main() -> None:
    print(greet("world"))
    squares = [n * n for n in range(1, 6)]
    print("squares:", squares)


if __name__ == "__main__":
    main()
`,
    },
  ]),
  builtin("javascript", "javascript", [
    {
      path: "index.js",
      content: src`// Run with: node index.js
function greet(name) {
  return "Hello, " + name + "!";
}

function sum(numbers) {
  return numbers.reduce((total, n) => total + n, 0);
}

module.exports = { greet, sum };

// Only run when this file is started directly, not when it is required.
if (require.main === module) {
  console.log(greet(process.argv[2] ?? "world"));
  console.log("sum:", sum([1, 2, 3, 4, 5]));
}
`,
    },
  ]),
  builtin("typescript", "typescript", [
    {
      path: "index.ts",
      content: src`interface Item {
  name: string;
  price: number;
  quantity: number;
}

function total(items: readonly Item[]): number {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

const cart: Item[] = [
  { name: "notebook", price: 3.5, quantity: 2 },
  { name: "pen", price: 1.2, quantity: 5 },
];

console.log("total:", total(cart).toFixed(2));
`,
    },
  ]),
  builtin("go", "go", [
    {
      path: "main.go",
      content: src`package main

import (
	"fmt"
	"os"
)

func greet(name string) string {
	return "Hello, " + name + "!"
}

func main() {
	name := "world"
	if len(os.Args) > 1 {
		name = os.Args[1]
	}
	fmt.Println(greet(name))

	sum := 0
	for i := 1; i <= 10; i++ {
		sum += i
	}
	fmt.Println("sum:", sum)
}
`,
    },
  ]),
  builtin("rust", "rust", [
    {
      path: "main.rs",
      content: src`fn greet(name: &str) -> String {
    format!("Hello, {name}!")
}

fn main() {
    let name = std::env::args().nth(1).unwrap_or_else(|| "world".to_string());
    println!("{}", greet(&name));

    let squares: Vec<u32> = (1..=5).map(|n| n * n).collect();
    println!("squares: {squares:?}");
}
`,
    },
  ]),
  builtin("c", "c", [
    {
      path: "main.c",
      content: src`#include <stdio.h>

static int sum_to(int n) {
    int total = 0;
    for (int i = 1; i <= n; i++) {
        total += i;
    }
    return total;
}

int main(int argc, char *argv[]) {
    const char *name = argc > 1 ? argv[1] : "world";
    printf("Hello, %s!\n", name);
    printf("1 + 2 + ... + 10 = %d\n", sum_to(10));
    return 0;
}
`,
    },
  ]),
  builtin("cpp", "cpp", [
    {
      path: "main.cpp",
      content: src`#include <iostream>
#include <numeric>
#include <string>
#include <vector>

int main(int argc, char* argv[]) {
    const std::string name = argc > 1 ? argv[1] : "world";
    std::cout << "Hello, " << name << "!\n";

    std::vector<int> numbers(10);
    std::iota(numbers.begin(), numbers.end(), 1);
    const int sum = std::accumulate(numbers.begin(), numbers.end(), 0);
    std::cout << "1 + 2 + ... + 10 = " << sum << "\n";
    return 0;
}
`,
    },
  ]),
  builtin("csharp", "csharp", [
    {
      path: "Program.cs",
      content: src`using System;
using System.Linq;

string name = args.Length > 0 ? args[0] : "world";
Console.WriteLine($"Hello, {name}!");

int sum = Enumerable.Range(1, 10).Sum();
Console.WriteLine($"1 + 2 + ... + 10 = {sum}");
`,
    },
  ]),
  builtin("kotlin", "kotlin", [
    {
      path: "Main.kt",
      content: src`fun greet(name: String): String = "Hello, $name!"

fun main(args: Array<String>) {
    val name = args.firstOrNull() ?: "world"
    println(greet(name))

    val squares = (1..5).map { it * it }
    println("squares: $squares")
}
`,
    },
  ]),
  builtin("swift", "swift", [
    {
      path: "main.swift",
      content: src`import Foundation

func greet(_ name: String) -> String {
    return "Hello, \(name)!"
}

let name = CommandLine.arguments.dropFirst().first ?? "world"
print(greet(name))

let squares = (1...5).map { $0 * $0 }
print("squares: \(squares)")
`,
    },
  ]),
  builtin("sql", "sql", [
    {
      path: "schema.sql",
      content: src`CREATE TABLE students (
    id    INTEGER PRIMARY KEY,
    name  TEXT NOT NULL,
    class TEXT NOT NULL
);

CREATE TABLE scores (
    student_id INTEGER NOT NULL REFERENCES students (id),
    subject    TEXT NOT NULL,
    score      INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
    PRIMARY KEY (student_id, subject)
);

INSERT INTO students (id, name, class) VALUES
    (1, 'Mina', 'A'),
    (2, 'Joon', 'A'),
    (3, 'Sora', 'B');

INSERT INTO scores (student_id, subject, score) VALUES
    (1, 'math', 92), (1, 'english', 88),
    (2, 'math', 75), (2, 'english', 81),
    (3, 'math', 64), (3, 'english', 90);
`,
    },
    {
      path: "query.sql",
      content: src`-- Average score per class, best class first.
SELECT s.class,
       COUNT(DISTINCT s.id)   AS students,
       ROUND(AVG(c.score), 1) AS average
FROM students AS s
JOIN scores AS c ON c.student_id = s.id
GROUP BY s.class
ORDER BY average DESC;
`,
    },
  ]),
  builtin("web", "html", [
    {
      path: "index.html",
      content: src`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Counter</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <main>
      <h1>Counter</h1>
      <p id="count" aria-live="polite">0</p>
      <button id="plus" type="button">Add one</button>
    </main>
    <script src="script.js"></script>
  </body>
</html>
`,
    },
    {
      path: "style.css",
      content: src`body {
  margin: 0;
  font-family: system-ui, sans-serif;
  background: #f6f7f9;
  color: #1c1f24;
}

main {
  max-width: 24rem;
  margin: 4rem auto;
  padding: 0 1rem;
  text-align: center;
}

#count {
  font-size: 3rem;
  margin: 1rem 0;
}

button {
  padding: 0.5rem 1.25rem;
  font-size: 1rem;
  border: 0;
  border-radius: 0.5rem;
  background: #2457c5;
  color: #fff;
  cursor: pointer;
}
`,
    },
    {
      path: "script.js",
      content: src`const count = document.getElementById("count");
const plus = document.getElementById("plus");
let value = 0;

plus.addEventListener("click", () => {
  value += 1;
  count.textContent = String(value);
});
`,
    },
  ]),
  builtin("markdown", "markdown", [
    {
      path: "README.md",
      content: src`# Project name

One sentence about what this project does and who it is for.

## Getting started

1. Install the dependencies.
2. Run the project.
3. Open it in your browser.

## Usage

${fence}sh
example --help
${fence}

## Notes

- [x] Write the first draft
- [ ] Review it together
- [ ] Publish

| Item  | Owner | Status      |
| ----- | ----- | ----------- |
| Setup | You   | In progress |
`,
    },
  ]),
  builtin("bash", "shell", [
    {
      path: "script.sh",
      content: src`#!/usr/bin/env bash
# Usage: ./script.sh [directory]
set -euo pipefail

dir="."
if [[ $# -gt 0 ]]; then
  dir="$1"
fi

if [[ ! -d "$dir" ]]; then
  echo "not a directory: $dir" >&2
  exit 1
fi

count=0
for file in "$dir"/*; do
  if [[ -f "$file" ]]; then
    count=$((count + 1))
    echo "file: $(basename "$file")"
  fi
done

echo "$count files in $dir"
`,
    },
  ]),
  builtin("python-package", "python", [
    {
      path: "calc/__init__.py",
      language: "python",
      content: src`from .ops import add, divide

__all__ = ["add", "divide"]
`,
    },
    {
      path: "calc/ops.py",
      language: "python",
      content: src`def add(a: float, b: float) -> float:
    return a + b


def divide(a: float, b: float) -> float:
    if b == 0:
        raise ValueError("cannot divide by zero")
    return a / b
`,
    },
    {
      path: "tests/test_ops.py",
      language: "python",
      content: src`import unittest

from calc import add, divide


class OpsTest(unittest.TestCase):
    def test_add(self):
        self.assertEqual(add(2, 3), 5)

    def test_divide(self):
        self.assertEqual(divide(6, 3), 2)

    def test_divide_by_zero(self):
        with self.assertRaises(ValueError):
            divide(1, 0)


if __name__ == "__main__":
    unittest.main()
`,
    },
    {
      path: "README.md",
      language: "markdown",
      content: src`# calc

A tiny Python package with tests.

${fence}sh
python -m unittest discover tests
${fence}
`,
    },
  ]),
];

/** Built-in templates in the shape of `GET /api/templates`. */
export function builtinTemplates(): Template[] {
  return BUILTIN_TEMPLATES.map((template) => ({
    id: template.id,
    name: template.nameKey,
    language: template.language,
    description: template.descriptionKey,
    files: template.files.map((file) => ({ ...file })),
    builtin: true,
  }));
}
