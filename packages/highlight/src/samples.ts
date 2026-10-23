/*
 * Realistic snippets, one per language. They drive the detection tests and the gallery's theme
 * previews, so each one exercises keywords, strings, comments-free typical code, numbers and types.
 * `GALLERY_LANGUAGES` are kept to 18 lines or fewer.
 */

// Template literals cannot hold a bare backtick; these keep the snippets readable.
const FENCE = "```";

export const SAMPLES: Readonly<Record<string, string>> = {
  typescript: `import type { Request, Response } from "express";

interface User {
  id: number;
  name: string;
  email?: string;
}

const users = new Map<number, User>();

export async function getUser(req: Request, res: Response): Promise<void> {
  const user = users.get(Number(req.params.id));
  if (!user) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(user);
}`,

  python: String.raw`from dataclasses import dataclass
import re

PATTERN = re.compile(r"^(\w+)@(\w+)\.com$")

@dataclass
class Account:
    name: str
    balance: float = 0.0

    def deposit(self, amount: float) -> None:
        if amount <= 0:
            raise ValueError("amount must be positive")
        self.balance += amount

if __name__ == "__main__":
    acct = Account("kim")
    acct.deposit(120.5)
    print(f"{acct.name}: {acct.balance:.2f}")`,

  java: `import java.util.List;
import java.util.stream.Collectors;

public class OrderService {
    private final List<Order> orders;

    public OrderService(List<Order> orders) {
        this.orders = orders;
    }

    @Override
    public String toString() {
        return orders.stream()
            .map(Order::getId)
            .collect(Collectors.joining(", "));
    }
}`,

  kotlin: `import kotlinx.coroutines.delay

data class Note(val id: Int, val title: String, val tags: List<String> = emptyList())

sealed interface Result {
    data class Ok(val notes: List<Note>) : Result
    object Empty : Result
}

suspend fun load(ids: List<Int>): Result {
    delay(50)
    val notes = ids.map { Note(it, "Note #$it") }
    return when {
        notes.isEmpty() -> Result.Empty
        else -> Result.Ok(notes)
    }
}`,

  go: `package main

import (
	"fmt"
	"net/http"
)

type Server struct {
	addr string
}

func (s *Server) Handle(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" {
		http.Error(w, "missing name", http.StatusBadRequest)
		return
	}
	fmt.Fprintf(w, "hello, %s\\n", name)
}`,

  rust: `use std::collections::HashMap;

#[derive(Debug, Clone)]
struct Item {
    name: String,
    qty: u32,
}

fn total(items: &[Item]) -> u32 {
    items.iter().map(|i| i.qty).sum()
}

fn main() {
    let mut stock: HashMap<String, Item> = HashMap::new();
    stock.insert("bolt".into(), Item { name: "bolt".into(), qty: 40 });
    let list: Vec<Item> = stock.values().cloned().collect();
    println!("total = {}", total(&list));
}`,

  sql: `CREATE TABLE orders (
  id INT PRIMARY KEY,
  customer_id INT NOT NULL,
  total DECIMAL(10, 2),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

SELECT c.name, COUNT(o.id) AS orders, SUM(o.total) AS revenue
FROM customers c
JOIN orders o ON o.customer_id = c.id
WHERE o.created_at >= '2026-01-01'
GROUP BY c.name
HAVING SUM(o.total) > 1000
ORDER BY revenue DESC
LIMIT 10;`,

  html: `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <title>codesh</title>
  <style>
    body { font: 16px/1.5 sans-serif; margin: 2rem; }
    .btn { color: #fff; background: #5b45c8; }
  </style>
</head>
<body>
  <button class="btn" id="go">Share</button>
  <script>
    document.getElementById("go").addEventListener("click", () => {
      console.log("shared");
    });
  </script>
</body>
</html>`,

  markdown: `# Release notes

Version **2.4** adds [live cursors](https://example.com/cursors).

## Changes

- Faster sync on large files
- Fixed a crash when pasting \`null\` bytes

${FENCE}ts
const room = connect("482913");
${FENCE}

> Tip: press ⌘K for the command palette.`,

  shell: `#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="$HOME/backups"
mkdir -p "$BACKUP_DIR"

for file in *.log; do
  if [[ -s "$file" ]]; then
    gzip -c "$file" > "$BACKUP_DIR/$file.gz"
    echo "archived $file"
  fi
done

echo "done: $(ls "$BACKUP_DIR" | wc -l) files"`,

  javascript: `const fs = require("fs");

function readConfig(path) {
  return new Promise((resolve, reject) => {
    fs.readFile(path, "utf8", (err, data) => {
      if (err) return reject(err);
      resolve(JSON.parse(data));
    });
  });
}

readConfig("./config.json")
  .then((cfg) => console.log(cfg.port))
  .catch(console.error);`,

  jsx: `import { useState } from "react";

export function Counter({ label }) {
  const [count, setCount] = useState(0);
  return (
    <button className="btn" onClick={() => setCount(count + 1)}>
      {label}: {count}
    </button>
  );
}`,

  tsx: `import { useState } from "react";

interface Props {
  label: string;
}

export function Counter({ label }: Props) {
  const [count, setCount] = useState<number>(0);
  return (
    <button className="btn" onClick={() => setCount(count + 1)}>
      {label}: {count}
    </button>
  );
}`,

  c: String.raw`#include <stdio.h>
#include <stdlib.h>

typedef struct Node {
    int value;
    struct Node *next;
} Node;

Node *push(Node *head, int value) {
    Node *n = malloc(sizeof(Node));
    n->value = value;
    n->next = head;
    return n;
}

int main(void) {
    Node *list = push(NULL, 42);
    printf("%d\n", list->value);
    free(list);
    return 0;
}`,

  cpp: `#include <iostream>
#include <vector>
#include <string>

template <typename T>
T largest(const std::vector<T>& values) {
    T best = values.front();
    for (const auto& v : values) {
        if (v > best) best = v;
    }
    return best;
}

int main() {
    std::vector<int> nums{3, 9, 4};
    std::cout << "max: " << largest(nums) << std::endl;
}`,

  csharp: `using System;
using System.Collections.Generic;
using System.Linq;

namespace Inventory
{
    public class Product
    {
        public string Name { get; set; }
        public decimal Price { get; init; }
    }

    public static class Program
    {
        public static void Main(string[] args)
        {
            var items = new List<Product> { new Product { Name = "pen", Price = 1.5m } };
            foreach (var p in items.Where(i => i.Price > 1))
                Console.WriteLine($"{p.Name}: {p.Price}");
        }
    }
}`,

  php: String.raw`<?php
declare(strict_types=1);

namespace App\Http;

class UserController
{
    public function show(int $id): array
    {
        $user = $this->repo->find($id);
        if ($user === null) {
            throw new \RuntimeException("User $id not found");
        }
        return ['id' => $user->id, 'name' => $user->name];
    }
}`,

  ruby: `require "json"

class Cart
  attr_reader :items

  def initialize
    @items = []
  end

  def add(name, price)
    @items << { name: name, price: price }
    self
  end

  def total
    items.sum { |i| i[:price] }
  end
end

puts Cart.new.add("tea", 3).total`,

  swift: String.raw`import SwiftUI

struct CounterView: View {
    @State private var count = 0

    var body: some View {
        VStack {
            Text("Count: \(count)")
            Button("Add") { count += 1 }
        }
    }
}

func greet(_ name: String?) -> String {
    guard let name = name else { return "hi" }
    return "hi, \(name)"
}`,

  css: `:root {
  --accent: #5b45c8;
}

.card {
  display: grid;
  gap: 12px;
  padding: 16px 20px;
  border: 1px solid var(--accent);
  transition: transform 120ms ease-out;
}

.card:hover {
  transform: translateY(-2px);
}

@media (max-width: 480px) {
  .card { padding: 12px; }
}`,

  scss: `$accent: #5b45c8;

@mixin pill($bg) {
  background: $bg;
  border-radius: 999px;
}

.tag {
  @include pill($accent);
  &:hover { filter: brightness(1.1); }
  .icon { margin-right: 4px; }
}`,

  json: `{
  "name": "codesh",
  "version": "1.2.0",
  "scripts": { "dev": "vite", "test": "vitest" },
  "keywords": ["share", "code"],
  "private": true
}`,

  yaml: `version: "3.9"
services:
  api:
    image: codesh/api:latest
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
  db:
    image: mongo:8
    volumes:
      - data:/data/db
volumes:
  data:`,

  xml: `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <dependencies>
    <dependency>
      <artifactId>junit</artifactId>
      <scope>test</scope>
    </dependency>
  </dependencies>
</project>`,

  dockerfile: `FROM node:22-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]`,

  vue: `<script setup lang="ts">
import { ref } from "vue";
const count = ref(0);
</script>

<template>
  <button @click="count++">Clicked {{ count }} times</button>
</template>

<style scoped>
button { color: #5b45c8; }
</style>`,

  svelte: `<script>
  export let items = [];
  let filter = "";
  $: visible = items.filter((i) => i.includes(filter));
</script>

<input bind:value={filter} />
{#each visible as item}
  <li>{item}</li>
{:else}
  <p>No items</p>
{/each}`,

  lua: `local M = {}

function M.sum(list)
  local total = 0
  for _, v in ipairs(list) do
    total = total + v
  end
  return total
end

if #arg > 0 then
  print("sum = " .. M.sum({1, 2, 3}))
end

return M`,

  haskell: `module Main where

import Data.List (sortBy)

data Shape = Circle Double | Rect Double Double

area :: Shape -> Double
area (Circle r) = pi * r * r
area (Rect w h) = w * h

main :: IO ()
main = do
  let shapes = [Circle 1.0, Rect 2 3]
  mapM_ (print . area) shapes`,

  toml: `[package]
name = "codesh"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = { version = "1", features = ["derive"] }
tokio = "1"`,

  diff: `diff --git a/src/app.ts b/src/app.ts
index 3f2a1b..9c8d7e 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@
 import { start } from "./server";
-const port = 3000;
+const port = Number(process.env.PORT ?? 3000);
+console.log("starting");
 start(port);`,

  perl: String.raw`#!/usr/bin/perl
use strict;
use warnings;

my %count;
while (my $line = <STDIN>) {
    chomp $line;
    $count{$_}++ for split /\s+/, $line;
}
print "$_: $count{$_}\n" for sort keys %count;`,

  r: `library(dplyr)

scores <- data.frame(name = c("a", "b"), value = c(3, 5))
top <- scores %>%
  filter(value > 3) %>%
  summarise(mean = mean(value))

print(top)`,

  dart: `import 'package:flutter/material.dart';

class Hello extends StatelessWidget {
  const Hello({super.key});

  @override
  Widget build(BuildContext context) {
    return const Text('Hello');
  }
}

void main() => runApp(const Hello());`,

  scala: `case class Point(x: Int, y: Int)

object Main {
  def dist(a: Point, b: Point): Double =
    math.hypot(a.x - b.x, a.y - b.y)

  def main(args: Array[String]): Unit = {
    val p = Point(0, 0)
    println(dist(p, Point(3, 4)))
  }
}`,

  powershell: `param([string]$Path = ".")

Get-ChildItem -Path $Path -Recurse -Filter *.log |
  Where-Object { $_.Length -gt 1MB } |
  ForEach-Object { Write-Host "$($_.Name) is large" }`,

  protobuf: `syntax = "proto3";

message Cursor {
  string user_id = 1;
  int32 line = 2;
  int32 column = 3;
}

service Presence {
  rpc Watch (Cursor) returns (Cursor);
}`,

  nginx: `server {
  listen 80;
  server_name codesh.local;

  location / {
    proxy_pass http://127.0.0.1:3000;
  }
}`,
};

/** The ten languages shown with every editor theme in the gallery, in display order. */
export const GALLERY_LANGUAGES = [
  "typescript",
  "python",
  "java",
  "kotlin",
  "go",
  "rust",
  "sql",
  "html",
  "markdown",
  "shell",
] as const;
