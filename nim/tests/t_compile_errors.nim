## Each tests/negative/<file>.nim must FAIL `nim check` with the message in expected.txt (AC3).
import std/[unittest, osproc, os, strutils]
let dir = currentSourcePath().parentDir / "negative"
suite "compile-time rejections":
  for line in readFile(dir / "expected.txt").strip.splitLines:
    let (file, expected) = (line.split('|')[0], line.split('|')[1])
    test file:
      let (output, code) = execCmdEx("nim check --hints:off --path:" & quoteShell(dir / "../../src") & " " & quoteShell(dir / file))
      check code != 0
      check expected in output
