/**
 * Tests for the Wave I language extractors: Python, Go, and Rust.
 *
 * Each test creates a minimal in-memory tree-sitter AST by parsing a code
 * snippet and verifying that the extractor returns the expected definitions,
 * imports, heritage, and calls.
 *
 * The tests use a simple mock-AST approach where the tree-sitter parser is
 * optional — if the native module is unavailable in the test environment the
 * tests are skipped gracefully. When the parser IS available (CI or local with
 * the native module built) the full parse + extract pipeline runs.
 *
 * @task T541
 */

import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Tree-sitter availability check
// ---------------------------------------------------------------------------

const _require = createRequire(import.meta.url);

type NativeParser = {
  setLanguage(lang: unknown): void;
  parse(source: string): { rootNode: unknown };
};

type ParserConstructor = new () => NativeParser;

let ParserClass: ParserConstructor | null = null;
let parserAvailable = false;

try {
  ParserClass = _require('tree-sitter') as ParserConstructor;
  parserAvailable = true;
} catch {
  parserAvailable = false;
}

/**
 * Load a grammar by package name, returning null if unavailable.
 */
function loadGrammar(pkg: string, prop?: string): unknown | null {
  try {
    const mod = _require(pkg) as Record<string, unknown>;
    return prop ? (mod[prop] ?? null) : mod;
  } catch {
    return null;
  }
}

/**
 * Parse source code with a given grammar and return the root node.
 * Returns null if the parser or grammar is unavailable.
 */
function parseSource(source: string, grammar: unknown): unknown | null {
  if (!ParserClass || !grammar) return null;
  try {
    const parser = new ParserClass();
    parser.setLanguage(grammar);
    const tree = parser.parse(source);
    return tree.rootNode;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Import extractors under test
// ---------------------------------------------------------------------------

import { extractGo } from '../pipeline/extractors/go-extractor.js';
import { extractPython } from '../pipeline/extractors/python-extractor.js';
import { extractRust } from '../pipeline/extractors/rust-extractor.js';

// ---------------------------------------------------------------------------
// Python extractor tests
// ---------------------------------------------------------------------------

describe('Python extractor', () => {
  let grammar: unknown | null = null;

  beforeAll(() => {
    grammar = loadGrammar('tree-sitter-python');
  });

  it('extracts top-level function definition', () => {
    if (!parserAvailable || !grammar) return;

    const source = `
def hello():
    pass

def greet(name, greeting="hi"):
    return name
`;
    const rootNode = parseSource(source, grammar);
    if (!rootNode) return;

    const result = extractPython(rootNode, 'test.py');

    const names = result.definitions.map((d) => d.name);
    expect(names).toContain('hello');
    expect(names).toContain('greet');

    const hello = result.definitions.find((d) => d.name === 'hello');
    expect(hello?.kind).toBe('function');
    expect(hello?.language).toBe('python');

    const greet = result.definitions.find((d) => d.name === 'greet');
    expect(greet?.parameters).toContain('name');
    expect(greet?.parameters).toContain('greeting');
  });

  it('extracts class with methods', () => {
    if (!parserAvailable || !grammar) return;

    const source = `
class MyClass(BaseClass):
    def __init__(self, name):
        self.name = name

    def method(self):
        pass
`;
    const rootNode = parseSource(source, grammar);
    if (!rootNode) return;

    const result = extractPython(rootNode, 'test.py');

    const classNode = result.definitions.find((d) => d.name === 'MyClass');
    expect(classNode).toBeDefined();
    expect(classNode?.kind).toBe('class');

    const initNode = result.definitions.find((d) => d.name === '__init__');
    expect(initNode?.kind).toBe('constructor');
    expect(initNode?.parent).toBe('test.py::MyClass');

    const methodNode = result.definitions.find((d) => d.name === 'method');
    expect(methodNode?.kind).toBe('method');
    expect(methodNode?.parent).toBe('test.py::MyClass');
  });

  it('extracts class heritage (superclasses)', () => {
    if (!parserAvailable || !grammar) return;

    const source = `
class Foo(Bar, Baz):
    pass
`;
    const rootNode = parseSource(source, grammar);
    if (!rootNode) return;

    const result = extractPython(rootNode, 'test.py');

    expect(result.heritage).toHaveLength(2);
    const heritageNames = result.heritage.map((h) => h.parentName);
    expect(heritageNames).toContain('Bar');
    expect(heritageNames).toContain('Baz');

    for (const h of result.heritage) {
      expect(h.typeName).toBe('Foo');
      expect(h.kind).toBe('extends');
    }
  });

  it('extracts import statements', () => {
    if (!parserAvailable || !grammar) return;

    const source = `
import os
import numpy as np
from typing import List, Optional
from . import utils
from ..models import User
`;
    const rootNode = parseSource(source, grammar);
    if (!rootNode) return;

    const result = extractPython(rootNode, 'test.py');

    const paths = result.imports.map((i) => i.rawImportPath);
    expect(paths).toContain('os');
    expect(paths).toContain('numpy');
    expect(paths).toContain('typing');

    const np = result.imports.find((i) => i.rawImportPath === 'numpy');
    expect(np?.namedBindings?.[0]?.local).toBe('np');
    expect(np?.namedBindings?.[0]?.exported).toBe('*');

    const typing = result.imports.find((i) => i.rawImportPath === 'typing');
    const bindings = typing?.namedBindings?.map((b) => b.local) ?? [];
    expect(bindings).toContain('List');
    expect(bindings).toContain('Optional');
  });

  it('extracts function calls and method calls', () => {
    if (!parserAvailable || !grammar) return;

    const source = `
def main():
    result = hello()
    user.save()
`;
    const rootNode = parseSource(source, grammar);
    if (!rootNode) return;

    const result = extractPython(rootNode, 'test.py');

    const freeCall = result.calls.find((c) => c.calledName === 'hello');
    expect(freeCall?.callForm).toBe('free');

    const memberCall = result.calls.find((c) => c.calledName === 'save');
    expect(memberCall?.callForm).toBe('member');
    expect(memberCall?.receiverName).toBe('user');
  });
});

// ---------------------------------------------------------------------------
// Go extractor tests
// ---------------------------------------------------------------------------

describe('Go extractor', () => {
  let grammar: unknown | null = null;

  beforeAll(() => {
    grammar = loadGrammar('tree-sitter-go');
  });

  it('extracts top-level function', () => {
    if (!parserAvailable || !grammar) return;

    const source = `
package main

func main() {
}

func add(a int, b int) int {
    return a + b
}
`;
    const rootNode = parseSource(source, grammar);
    if (!rootNode) return;

    const result = extractGo(rootNode, 'main.go');

    const mainFn = result.definitions.find((d) => d.name === 'main');
    expect(mainFn?.kind).toBe('function');
    expect(mainFn?.language).toBe('go');

    const addFn = result.definitions.find((d) => d.name === 'add');
    expect(addFn?.kind).toBe('function');
    expect(addFn?.parameters).toContain('a');
    expect(addFn?.parameters).toContain('b');
  });

  it('extracts method with receiver', () => {
    if (!parserAvailable || !grammar) return;

    const source = `
package main

type Server struct{}

func (s *Server) Handle(w http.ResponseWriter, r *http.Request) {}
`;
    const rootNode = parseSource(source, grammar);
    if (!rootNode) return;

    const result = extractGo(rootNode, 'server.go');

    const method = result.definitions.find((d) => d.name === 'Handle');
    expect(method?.kind).toBe('method');
    expect(method?.parent).toBe('server.go::Server');
  });

  it('extracts struct and interface definitions', () => {
    if (!parserAvailable || !grammar) return;

    const source = `
package models

type User struct {
    Name string
    Age  int
}

type Storer interface {
    Save(u User) error
    Find(id int) (User, error)
}
`;
    const rootNode = parseSource(source, grammar);
    if (!rootNode) return;

    const result = extractGo(rootNode, 'models.go');

    const userStruct = result.definitions.find((d) => d.name === 'User');
    expect(userStruct?.kind).toBe('struct');
    expect(userStruct?.exported).toBe(true);

    const storerInterface = result.definitions.find((d) => d.name === 'Storer');
    expect(storerInterface?.kind).toBe('interface');
  });

  it('extracts import declarations', () => {
    if (!parserAvailable || !grammar) return;

    const source = `
package main

import (
    "fmt"
    "net/http"
    f "os"
)
`;
    const rootNode = parseSource(source, grammar);
    if (!rootNode) return;

    const result = extractGo(rootNode, 'main.go');

    const paths = result.imports.map((i) => i.rawImportPath);
    expect(paths).toContain('fmt');
    expect(paths).toContain('net/http');
    expect(paths).toContain('os');

    const aliased = result.imports.find((i) => i.rawImportPath === 'os');
    expect(aliased?.namedBindings?.[0]?.local).toBe('f');
  });

  it('extracts struct embedding as heritage', () => {
    if (!parserAvailable || !grammar) return;

    const source = `
package main

type Base struct {
    ID int
}

type Admin struct {
    Base
    Role string
}
`;
    const rootNode = parseSource(source, grammar);
    if (!rootNode) return;

    const result = extractGo(rootNode, 'main.go');

    const heritage = result.heritage.find((h) => h.typeName === 'Admin' && h.parentName === 'Base');
    expect(heritage).toBeDefined();
    expect(heritage?.kind).toBe('extends');
  });

  it('extracts function and method calls', () => {
    if (!parserAvailable || !grammar) return;

    const source = `
package main

import "fmt"

func main() {
    fmt.Println("hello")
    greet()
}
`;
    const rootNode = parseSource(source, grammar);
    if (!rootNode) return;

    const result = extractGo(rootNode, 'main.go');

    const memberCall = result.calls.find((c) => c.calledName === 'Println');
    expect(memberCall?.callForm).toBe('member');
    expect(memberCall?.receiverName).toBe('fmt');

    const freeCall = result.calls.find((c) => c.calledName === 'greet');
    expect(freeCall?.callForm).toBe('free');
  });
});

// ---------------------------------------------------------------------------
// Rust extractor tests
// ---------------------------------------------------------------------------

describe('Rust extractor', () => {
  let grammar: unknown | null = null;

  beforeAll(() => {
    grammar = loadGrammar('tree-sitter-rust');
  });

  it('extracts top-level function', () => {
    if (!parserAvailable || !grammar) return;

    const source = `
fn hello() {
}

pub fn greet(name: &str, times: u32) -> String {
    name.to_string()
}
`;
    const rootNode = parseSource(source, grammar);
    if (!rootNode) return;

    const result = extractRust(rootNode, 'lib.rs');

    const hello = result.definitions.find((d) => d.name === 'hello');
    expect(hello?.kind).toBe('function');
    expect(hello?.language).toBe('rust');
    expect(hello?.exported).toBe(false);

    const greet = result.definitions.find((d) => d.name === 'greet');
    expect(greet?.exported).toBe(true);
    expect(greet?.parameters).toContain('name');
    expect(greet?.parameters).toContain('times');
  });

  it('extracts struct definition with fields', () => {
    if (!parserAvailable || !grammar) return;

    const source = `
pub struct MyStruct {
    pub name: String,
    value: i32,
}
`;
    const rootNode = parseSource(source, grammar);
    if (!rootNode) return;

    const result = extractRust(rootNode, 'lib.rs');

    const structNode = result.definitions.find((d) => d.name === 'MyStruct');
    expect(structNode?.kind).toBe('struct');
    expect(structNode?.exported).toBe(true);

    const nameField = result.definitions.find(
      (d) => d.name === 'name' && d.parent?.includes('MyStruct'),
    );
    expect(nameField?.kind).toBe('property');
  });

  it('extracts enum, trait, and impl', () => {
    if (!parserAvailable || !grammar) return;

    const source = `
pub enum Status {
    Active,
    Inactive,
}

pub trait Describable {
    fn describe(&self) -> String;
}

impl Describable for Status {
    fn describe(&self) -> String {
        "status".to_string()
    }
}
`;
    const rootNode = parseSource(source, grammar);
    if (!rootNode) return;

    const result = extractRust(rootNode, 'lib.rs');

    const enumNode = result.definitions.find((d) => d.name === 'Status');
    expect(enumNode?.kind).toBe('enum');

    const traitNode = result.definitions.find((d) => d.name === 'Describable');
    expect(traitNode?.kind).toBe('trait');

    // impl Describable for Status → heritage record
    const heritage = result.heritage.find(
      (h) => h.typeName === 'Status' && h.parentName === 'Describable',
    );
    expect(heritage).toBeDefined();
    expect(heritage?.kind).toBe('implements');

    // describe method emitted inside impl
    const describeMethod = result.definitions.find(
      (d) => d.name === 'describe' && d.parent?.includes('Status'),
    );
    expect(describeMethod?.kind).toBe('method');
  });

  it('extracts use declarations', () => {
    if (!parserAvailable || !grammar) return;

    const source = `
use std::collections::HashMap;
use std::io::{self, Read, Write};
use crate::models::User;
use super::utils::*;
`;
    const rootNode = parseSource(source, grammar);
    if (!rootNode) return;

    const result = extractRust(rootNode, 'lib.rs');

    // Should have records for HashMap, Read, Write, User
    const allBindings = result.imports.flatMap((i) => i.namedBindings?.map((b) => b.local) ?? []);

    expect(allBindings).toContain('HashMap');
    expect(allBindings).toContain('Read');
    expect(allBindings).toContain('Write');
    expect(allBindings).toContain('User');

    // Wildcard import from super::utils
    const wildcardImport = result.imports.find((i) =>
      i.namedBindings?.some((b) => b.exported === '*'),
    );
    expect(wildcardImport).toBeDefined();
  });

  it('extracts function and method calls', () => {
    if (!parserAvailable || !grammar) return;

    const source = `
fn main() {
    let m = MyStruct::new();
    m.do_something();
    free_call();
}
`;
    const rootNode = parseSource(source, grammar);
    if (!rootNode) return;

    const result = extractRust(rootNode, 'lib.rs');

    // MyStruct::new() — associated function call
    const newCall = result.calls.find((c) => c.calledName === 'new');
    expect(newCall).toBeDefined();
    expect(newCall?.receiverName).toBe('MyStruct');

    // m.do_something() — method call
    const memberCall = result.calls.find((c) => c.calledName === 'do_something');
    expect(memberCall?.callForm).toBe('member');

    // free_call() — free call
    const freeCall = result.calls.find((c) => c.calledName === 'free_call');
    expect(freeCall?.callForm).toBe('free');
  });

  it('extracts impl methods with correct parent', () => {
    if (!parserAvailable || !grammar) return;

    const source = `
struct Counter {
    count: u32,
}

impl Counter {
    pub fn new(start: u32) -> Self {
        Counter { count: start }
    }

    pub fn increment(&mut self) {
        self.count += 1;
    }
}
`;
    const rootNode = parseSource(source, grammar);
    if (!rootNode) return;

    const result = extractRust(rootNode, 'counter.rs');

    const newMethod = result.definitions.find((d) => d.name === 'new');
    expect(newMethod?.kind).toBe('constructor');
    expect(newMethod?.parent).toBe('counter.rs::Counter');

    const incrementMethod = result.definitions.find((d) => d.name === 'increment');
    expect(incrementMethod?.kind).toBe('method');
    expect(incrementMethod?.parent).toBe('counter.rs::Counter');
  });
});
