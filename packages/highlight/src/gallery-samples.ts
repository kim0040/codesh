/** Small preview documents for the ten languages shown in the theme gallery. */
export const GALLERY_SAMPLES: Readonly<Record<string, string>> = {
  typescript: `interface User { id: number; name: string }
const user: User = { id: 1, name: "Mina" };
export function greet(value: User): string {
  return "Hello, " + value.name + "!";
}`,
  python: `from dataclasses import dataclass

@dataclass
class User:
    name: str
    active: bool = True`,
  java: `public final class Greeting {
  public static String hello(String name) {
    return "Hello, " + name;
  }
}`,
  kotlin: `data class User(val name: String, val active: Boolean = true)

fun greet(user: User): String = "Hello, \${user.name}"`,
  go: `package main

import "fmt"

func main() { fmt.Println("hello") }`,
  rust: `struct User { name: String, active: bool }

fn greet(user: &User) -> String {
    format!("Hello, {}", user.name)
}`,
  sql: `SELECT name, COUNT(*) AS orders
FROM customers
WHERE active = TRUE
GROUP BY name
ORDER BY orders DESC;`,
  html: `<!doctype html>
<article class="welcome">
  <h1>Hello, <span id="name">Mina</span></h1>
</article>`,
  markdown: `# Hello, **Mina**

Use [gachipad](https://example.com) to share code.

- Edit together
- Keep history private`,
  shell: `#!/usr/bin/env bash
set -euo pipefail

name="Mina"
printf 'Hello, %s!\\n' "$name"`,
};
