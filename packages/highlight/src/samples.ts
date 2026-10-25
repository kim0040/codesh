/*
 * Realistic snippets, one per language. They drive the detection tests and the gallery's theme
 * previews, so each one exercises keywords, strings, comments-free typical code, numbers and types.
 * The gallery preview data is kept separately so this test dataset stays out of the initial bundle.
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
  <title>gachipad</title>
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

  angular: `<article class="welcome">
  <h1>{{ title }}</h1>
  @if (user; as currentUser) {
    <button type="button" (click)="save(currentUser)">Save</button>
  }
</article>`,

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
  "name": "gachipad",
  "version": "1.2.0",
  "scripts": { "dev": "vite", "test": "vitest" },
  "keywords": ["share", "code"],
  "private": true
}`,

  yaml: `version: "3.9"
services:
  api:
    image: gachipad/api:latest
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
name = "gachipad"
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
  server_name gachipad.local;

  location / {
    proxy_pass http://127.0.0.1:3000;
  }
}`,

  lezer: `@top Expression { Identifier ("+" Identifier)* }
Identifier { $[a-z]+ }

@tokens {
  Identifier { $[a-zA-Z_][\\w]* }
  space { $[ \t\n\r]+ }
}`,

  nix: `let
  port = 8080;
  greeting = "hello";
in {
  inherit greeting;
  servicePort = port;
}`,

  solidity: `pragma solidity ^0.8.24;

contract Counter {
    uint256 public value;
    event Changed(uint256 value);

    function increment() public {
        value += 1;
        emit Changed(value);
    }
}`,

  elixir: `defmodule Counter do
  @moduledoc "A tiny counter"

  def increment(value) when is_integer(value) do
    value + 1
  end
end`,

  hcl: `variable "bucket_name" {
  type    = string
  default = "gachipad-assets"
}

resource "aws_s3_bucket" "assets" {
  bucket = var.bucket_name
  tags   = { Environment = "dev" }
}`,

  terraform: `terraform {
  required_version = ">= 1.8"
}

resource "aws_s3_bucket" "assets" {
  bucket = "gachipad-assets"
  tags   = { Environment = "dev" }
}`,

  promql: `# Request rate by status over five minutes
sum by (status) (
  rate(http_requests_total{method="GET", status=~"2.."}[5m])
)`,

  astro: `---
const title = "gachipad";
const count = 3;
---
<html lang="en">
  <h1>{title}</h1>
  <p>Open rooms: {count}</p>
</html>`,

  groq: `*[_type == "post" && publishedAt < now()]
  | order(publishedAt desc) {
    title,
    "slug": slug.current
  }`,

  pegjs: `Start
  = left:Value "+" right:Value { return left + right; }

Value
  = digits:[0-9]+ { return Number(digits.join("")); }
  / "(" value:Start ")" { return value; }`,

  graphql: `# Fetch a public profile
query Profile($id: ID!) {
  user(id: $id) {
    name
    active
  }
}`,

  prisma: `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id    Int    @id @default(autoincrement())
  name  String
  posts Post[]
}`,

  jsonc: `{
  // The editor accepts comments in this file.
  theme: "dark",
  tabSize: 2,
}`,

  json5: `{
  // JSON5 allows bare keys and trailing commas.
  name: 'gachipad',
  enabled: true,
  retries: 3,
}`,

  jsonl: `{"event":"join","room":"482913","count":2}
{"event":"edit","room":"482913","count":3}
{"event":"leave","room":"482913","count":2}`,

  "json-schema": `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Room",
  "type": "object",
  "properties": { "code": { "type": "string" } }
}`,

  jsonnet: `local port = 8080;
{
  service: {
    name: "gachipad",
    port: port,
  },
}`,

  mdx: `# Release notes

The **new editor** supports <Badge>shared cursors</Badge>.

${FENCE}ts
const rooms = 3;
${FENCE}`,

  asciidoc: `= Shared rooms
// This page is a short guide.

The editor supports *fast* responses and links.

[source,js]
----
const active = true;
----`,

  restructuredtext: `Shared rooms
============

The editor supports **fast** responses and links.

.. code-block:: python

   print("ready")`,

  org: `* Shared rooms
** Examples

The editor supports /fast/ responses and [[https://example.com][links]].

#+begin_src python
value = 3
#+end_src`,

  starlark: `load("@rules_cc//cc:defs.bzl", "cc_binary")

cc_binary(
    name = "hello",
    srcs = ["main.cc"],
)`,

  arduino: `const int ledPin = 13;

void setup() {
  pinMode(ledPin, OUTPUT);
}

void loop() {
  digitalWrite(ledPin, HIGH);
  delay(250);
}`,

  cuda: `__global__ void add(const float* a, const float* b, float* out) {
  const int i = threadIdx.x + blockIdx.x * blockDim.x;
  out[i] = a[i] + b[i];
}

int main() { return 0; }`,

  opencl: `__kernel void add(__global const float* a,
                    __global const float* b,
                    __global float* out) {
  const int i = get_global_id(0);
  out[i] = a[i] + b[i];
}`,

  glsl: `#version 450
layout(location = 0) in vec3 position;
layout(location = 0) out vec4 color;

void main() {
  color = vec4(position, 1.0);
}`,

  hlsl: `struct VertexInput { float3 position : POSITION; };
struct VertexOutput { float4 position : SV_POSITION; };

VertexOutput main(VertexInput input) {
  VertexOutput output;
  output.position = float4(input.position, 1.0);
  return output;
}`,

  wgsl: `struct VertexOutput {
  @builtin(position) position: vec4<f32>,
}

@vertex
fn vertex_main(@location(0) point: vec3<f32>) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4<f32>(point, 1.0);
  return output;
}`,

  ispc: `export uniform int add_vectors(uniform int count,
                                      uniform int* a,
                                      uniform int* b,
                                      uniform int* out) {
  foreach (i = 0 ... count) {
    out[i] = a[i] + b[i];
  }
  return count;
}`,

  zig: `const std = @import("std");

pub fn main() !void {
    const count: u32 = 3;
    std.debug.print("items: {d}\\n", .{count});
}`,

  move: `module 0x1::counter {
    public struct Counter has key { value: u64 }

    public fun increment(counter: &mut Counter) {
        counter.value = counter.value + 1;
    }
}`,

  cairo: `fn add(a: felt252, b: felt252) -> felt252 {
    let total = a + b;
    total
}

#[test]
fn adds_values() {
    assert(add(2, 3) == 5, "sum");
}`,

  qsharp: `namespace Quantum {
    open Microsoft.Quantum.Intrinsic;

    @EntryPoint()
    operation Hello() : Unit {
        Message("hello");
    }
}`,

  apex: `public with sharing class ContactService {
    public static void greet(Contact person) {
        System.debug('Hello ' + person.Name);
    }
}`,

  graphviz: `// A small directed graph
digraph rooms {
  node [shape=box];
  lobby -> editor [label="open"];
  editor -> lobby [label="leave"];
}`,

  mermaid: `%% Room lifecycle
flowchart LR
  A[Create] --> B{Join?}
  B -- yes --> C[Edit]
  B -- no --> D[Close]`,

  plantuml: `' A short interaction
@startuml
participant Host
participant Guest
Host -> Guest: "join room"
Guest --> Host: "ready"
@enduml`,

  prolog: `% Find a parent-child path.
parent(alex, sam).
parent(sam, lee).

ancestor(X, Y) :- parent(X, Y).
ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).`,

  batch: `@echo off
rem Prepare a release
set COUNT=3
if %COUNT% GEQ 1 echo "ready"
exit /b 0`,

  autohotkey: `#Requires AutoHotkey v2.0
; Press Ctrl+J to open the room.
^j:: {
    room := "482913"
    MsgBox("Opening " room)
}`,

  abap: `REPORT z_gachipad_demo.

DATA lv_count TYPE i VALUE 3.
WRITE 'Active rooms'.
WRITE lv_count.`,

  stata: `* Summarize active rooms
clear all
input name score
"alpha" 9
"beta" 7
end
generate passed = score >= 8
summarize passed`,

  handlebars: `<h1>{{title}}</h1>
{{#each rooms}}
  <p>{{name}}: {{count}}</p>
{{/each}}`,

  twig: `<h1>{{ title }}</h1>
{% for room in rooms %}
  <p>{{ room.name }}: {{ room.count }}</p>
{% endfor %}`,

  nunjucks: `<h1>{{ title }}</h1>
{% for room in rooms %}
  <p>{{ room.name }}: {{ room.count }}</p>
{% endfor %}`,

  "django-template": `<h1>{{ title }}</h1>
{% for room in rooms %}
  <p>{{ room.name }}: {{ room.count }}</p>
{% endfor %}`,

  makefile: `# Build and verify the application.
.PHONY: check
check:
	pnpm test

clean:
	rm -rf dist`,

  gradle: `plugins {
    id 'java'
}

group = 'dev.gachipad'
version = '1.0'

tasks.register('verify') {
    doLast { println 'ready' }
}`,

  "gradle-kotlin": `plugins {
    kotlin("jvm") version "2.0.0"
}

tasks.register("verify") {
    doLast { println("ready") }
}`,

  meson: `project('gachipad', 'cpp', version: '1.0')

source = files('main.cpp')
executable('gachipad-demo', source,
  install: true,
)`,

  ninja: `cflags = -O2

rule compile
  command = c++ $cflags -c $in -o $out

build app.o: compile app.cpp`,

  "docker-compose": `services:
  web:
    image: gachipad:latest
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production`,

  "github-actions": `name: Check
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm check`,

  "gitlab-ci": `stages:
  - test

unit-tests:
  stage: test
  image: node:22
  script:
    - pnpm install --frozen-lockfile
    - pnpm test`,

  ansible: `- name: Configure web server
  hosts: web
  become: true
  tasks:
    - name: Install nginx
      ansible.builtin.package:
        name: nginx
        state: present`,

  kubernetes: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: gachipad
spec:
  replicas: 2
  selector:
    matchLabels:
      app: gachipad`,

  openapi: `openapi: 3.1.0
info:
  title: gachipad API
  version: "1.0"
paths:
  /health:
    get:
      responses:
        "200": { description: ready }`,
};

/** New rows all have realistic snippets; only distinctive samples feed content detection. */
export const NEW_LANGUAGE_IDS = [
  "lezer",
  "nix",
  "solidity",
  "elixir",
  "hcl",
  "promql",
  "astro",
  "groq",
  "pegjs",
  "graphql",
  "prisma",
  "wgsl",
  "zig",
  "graphviz",
  "mermaid",
  "plantuml",
  "prolog",
  "batch",
  "autohotkey",
  "abap",
  "stata",
  "terraform",
  "jsonc",
  "json5",
  "jsonl",
  "json-schema",
  "jsonnet",
  "mdx",
  "asciidoc",
  "restructuredtext",
  "org",
  "starlark",
  "arduino",
  "cuda",
  "opencl",
  "glsl",
  "hlsl",
  "ispc",
  "move",
  "cairo",
  "qsharp",
  "apex",
  "handlebars",
  "twig",
  "nunjucks",
  "django-template",
  "makefile",
  "gradle",
  "gradle-kotlin",
  "meson",
  "ninja",
  "docker-compose",
  "github-actions",
  "gitlab-ci",
  "ansible",
  "kubernetes",
  "openapi",
] as const;

const CONTENT_DETECTION_IDS = [
  "nix",
  "solidity",
  "elixir",
  "terraform",
  "graphql",
  "promql",
  "astro",
  "groq",
] as const;

const existingDetectionSamples = Object.fromEntries(
  Object.entries(SAMPLES).filter(
    ([id]) => !NEW_LANGUAGE_IDS.includes(id as (typeof NEW_LANGUAGE_IDS)[number]),
  ),
);

export const DETECTION_SAMPLES: Readonly<Record<string, string>> = {
  ...existingDetectionSamples,
  ...Object.fromEntries(CONTENT_DETECTION_IDS.map((id) => [id, SAMPLES[id] ?? ""])),
};
