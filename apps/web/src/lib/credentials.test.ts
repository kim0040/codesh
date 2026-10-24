import { describe, expect, it } from "vitest";
import { scrubLocation, stripKey } from "./credentials";

describe("stripKey", () => {
  it("takes the key out and keeps other entries byte for byte", () => {
    expect(stripKey("#key=abc%2Fdef&line=4")).toEqual({ key: "abc/def", rest: "#line=4" });
    expect(stripKey("?a=1&key=k1&b=%20x")).toEqual({ key: "k1", rest: "?a=1&b=%20x" });
  });

  it("drops the separator when nothing else is left", () => {
    expect(stripKey("#key=k1")).toEqual({ key: "k1", rest: "" });
    expect(stripKey("?key=k1")).toEqual({ key: "k1", rest: "" });
  });

  it("leaves parts without a key alone", () => {
    expect(stripKey("")).toEqual({ key: null, rest: "" });
    expect(stripKey("#section-2")).toEqual({ key: null, rest: "#section-2" });
    expect(stripKey("?keyboard=1")).toEqual({ key: null, rest: "?keyboard=1" });
  });

  it("scrubs an empty key without capturing anything", () => {
    expect(stripKey("#key=")).toEqual({ key: null, rest: "" });
  });
});

describe("scrubLocation", () => {
  const path = "/abcd1234";

  it("reads a new link from the fragment", () => {
    expect(scrubLocation({ pathname: path, search: "", hash: "#key=k1" })).toEqual({
      key: "k1",
      url: path,
    });
  });

  it("still accepts a legacy link with the key in the query", () => {
    expect(scrubLocation({ pathname: path, search: "?key=k1", hash: "" })).toEqual({
      key: "k1",
      url: path,
    });
  });

  it("keeps unrelated search and hash state", () => {
    expect(scrubLocation({ pathname: path, search: "?a=1&key=k1", hash: "#x=2" })).toEqual({
      key: "k1",
      url: `${path}?a=1#x=2`,
    });
    expect(scrubLocation({ pathname: path, search: "?a=1", hash: "#key=k1&x=2" })).toEqual({
      key: "k1",
      url: `${path}?a=1#x=2`,
    });
  });

  it("prefers the fragment when both carry a key and removes both", () => {
    expect(scrubLocation({ pathname: path, search: "?key=old", hash: "#key=new" })).toEqual({
      key: "new",
      url: path,
    });
  });

  it("does nothing without a key", () => {
    expect(scrubLocation({ pathname: path, search: "?a=1", hash: "#x" })).toEqual({
      key: null,
      url: null,
    });
  });
});
