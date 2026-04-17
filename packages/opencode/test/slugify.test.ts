import { test, expect } from "bun:test"
import { slugify } from "../src/util/slugify"

test("slugify basic space to hyphen and lowercase", () => {
  expect(slugify("Hello World")).toBe("hello-world")
})

test("slugify multiple spaces merge and trim", () => {
  expect(slugify("  Foo   Bar  ")).toBe("foo-bar")
})

test("slugify punctuation removal", () => {
  expect(slugify("Hello, World!")).toBe("hello-world")
})

test("slugify consecutive hyphens merge", () => {
  expect(slugify("foo---bar")).toBe("foo-bar")
})

test("slugify leading hyphens removal", () => {
  expect(slugify("---leading")).toBe("leading")
})

test("slugify trailing hyphens removal", () => {
  expect(slugify("trailing---")).toBe("trailing")
})

test("slugify no separator passes through", () => {
  expect(slugify("HelloWorld")).toBe("helloworld")
})

test("slugify numbers preserved", () => {
  expect(slugify("123 ABC")).toBe("123-abc")
})

test("slugify empty string boundary", () => {
  expect(slugify("")).toBe("")
})

test("slugify all special chars boundary", () => {
  expect(slugify("---")).toBe("")
})

test("slugify mixed special chars", () => {
  expect(slugify("Hello & World? Yes!")).toBe("hello-world-yes")
})

test("slugify non-ASCII chars stripped", () => {
  expect(slugify("café résumé")).toBe("caf-r-sum")
})
