import { describe, expect, it } from "vitest"
import { boundOutputTotal } from "../src/output.ts"
import { DEFAULT_OPTIONS } from "../src/options.ts"
import {
  analyzeDiffs,
  isCiPath,
  isTestPath,
  parsePatchFiles,
  patchDisablesTests,
  rankCandidates,
  shapeRace,
  verificationFor,
  type CandidateRecord,
  type RaceRecord,
} from "../src/races.ts"

function candidate(overrides: Partial<CandidateRecord>): CandidateRecord {
  return {
    candidateID: "candidate-1",
    index: 0,
    messageID: "msg_1",
    directory: "C:/repo",
    strategy: "worktree",
    base: "base",
    commit: "commit",
    patch: "",
    patchBytes: 0,
    diffComplete: true,
    snapshotSource: "git-commit",
    files: [],
    diffStats: { files: 0, additions: 0, deletions: 0 },
    testFilesChanged: false,
    ciFilesChanged: false,
    skippedTests: false,
    verification: "trusted",
    tests: { skipped: false, passed: true, exitCode: 0 },
    state: "idle",
    elapsedMs: 100,
    applyStrategy: "cherry-pick",
    ...overrides,
  }
}

describe("race diff analysis", () => {
  it("parses files, renames, binary flags, submodules and LFS", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/a.ts",
      "@@ -0,0 +1 @@",
      "+export const a = 1",
      "diff --git a/old.ts b/new.ts",
      "similarity index 90%",
      "rename from old.ts",
      "rename to new.ts",
      "diff --git a/logo.png b/logo.png",
      "GIT binary patch",
      "literal 4",
      "diff --git a/vendor/lib b/vendor/lib",
      "Subproject commit 0123456789abcdef",
      "diff --git a/model.bin b/model.bin",
      "version https://git-lfs.github.com/spec/v1",
    ].join("\n")
    const files = parsePatchFiles(patch)
    expect(files.map((file) => file.file)).toEqual(["src/a.ts", "new.ts", "logo.png", "vendor/lib", "model.bin"])
    expect(files[0]?.status).toBe("added")

    const spaced = parsePatchFiles(
      [
        'diff --git "a/foo bar.txt" "b/foo bar.txt"',
        '--- "a/foo bar.txt"',
        '+++ "b/foo bar.txt"',
        "@@ -1 +1 @@",
        "+space",
      ].join("\n"),
    )
    expect(spaced[0]?.file).toBe("foo bar.txt")
    expect(spaced[0]?.additions).toBe(1)

    const analysis = analyzeDiffs(files, patch, 100_000)
    expect(analysis.files.some((file) => file.renamed)).toBe(true)
    expect(analysis.files.some((file) => file.binary)).toBe(true)
    expect(analysis.files.some((file) => file.submodule)).toBe(true)
    expect(analysis.files.some((file) => file.lfs)).toBe(true)
    expect(analysis.submodule).toBe(true)
  })

  it("flags test and CI changes and disabled tests", () => {
    const patch = [
      "diff --git a/tests/a.test.ts b/tests/a.test.ts",
      "--- a/tests/a.test.ts",
      "+++ b/tests/a.test.ts",
      "@@ -1 +1 @@",
      "+it.skip('broken', () => {})",
      "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml",
      "--- a/.github/workflows/ci.yml",
      "+++ b/.github/workflows/ci.yml",
      "@@ -1 +1 @@",
      "+run: npm test -- --passWithNoTests",
    ].join("\n")
    const files = parsePatchFiles(patch)
    const analysis = analyzeDiffs(files, patch, 100_000)
    expect(analysis.testFilesChanged).toBe(true)
    expect(analysis.ciFilesChanged).toBe(true)
    expect(analysis.skippedTests).toBe(true)
    expect(patchDisablesTests("+describe.skip('x', () => {})")).toBe(true)
    expect(patchDisablesTests("-describe.skip('x', () => {})")).toBe(false)
    expect(isTestPath("src/a.test.ts")).toBe(true)
    expect(isTestPath("e2e/login.ts")).toBe(true)
    expect(isCiPath(".github/workflows/ci.yml")).toBe(true)
  })

  it("classifies verification as trusted, flagged, or unknown", () => {
    expect(
      verificationFor({
        testsSkipped: false,
        testsPassed: true,
        testFilesChanged: false,
        ciFilesChanged: false,
        skippedTests: false,
        allowTestChanges: false,
      }),
    ).toBe("trusted")
    expect(
      verificationFor({
        testsSkipped: false,
        testsPassed: true,
        testFilesChanged: true,
        ciFilesChanged: false,
        skippedTests: false,
        allowTestChanges: false,
      }),
    ).toBe("flagged")
    expect(
      verificationFor({
        testsSkipped: false,
        testsPassed: false,
        testFilesChanged: false,
        ciFilesChanged: false,
        skippedTests: false,
        allowTestChanges: true,
      }),
    ).toBe("flagged")
    expect(
      verificationFor({
        testsSkipped: true,
        testsPassed: undefined,
        testFilesChanged: false,
        ciFilesChanged: false,
        skippedTests: false,
        allowTestChanges: true,
      }),
    ).toBe("unknown")
  })

  it("ranks only trusted, passing candidates and keeps reasons explicit", () => {
    const trusted = candidate({
      candidateID: "candidate-trusted",
      diffStats: { files: 1, additions: 5, deletions: 1 },
    })
    const failed = candidate({
      candidateID: "candidate-failed",
      tests: { skipped: false, passed: false, exitCode: 1 },
      verification: "flagged",
      diffStats: { files: 1, additions: 1, deletions: 0 },
    })
    const skipped = candidate({
      candidateID: "candidate-skipped",
      tests: { skipped: true, reason: "no command" },
      verification: "unknown",
      diffStats: { files: 1, additions: 1, deletions: 1 },
    })
    const ranking = rankCandidates([failed, skipped, trusted])
    expect(ranking.recommended).toBe("candidate-trusted")
    expect(ranking.ranking[0]).toBe("candidate-trusted")
    expect(ranking.rankingReasons).toContain("tests-passed")

    const none = rankCandidates([failed])
    expect(none.recommended).toBeUndefined()
    expect(none.rankingReasons).toContain("no-trusted-candidate")
  })

  it("never recommends a candidate with skipped tests", () => {
    const skipped = candidate({
      candidateID: "candidate-skipped",
      tests: { skipped: true, reason: "missing secrets" },
      verification: "unknown",
    })
    const ranking = rankCandidates([skipped])
    expect(ranking.recommended).toBeUndefined()
    expect(ranking.rankingReasons).toContain("tests-skipped")
  })

  it("P1-1: bounds a large race to the global output budget and keeps critical IDs", () => {
    const files = Array.from({ length: 50 }, (_, index) => ({
      file: `src/file-${index}.ts`,
      status: "modified" as const,
      additions: 10,
      deletions: 2,
      patch: `+${"x".repeat(1_000)}\n`,
    }))
    const candidates = Array.from({ length: 8 }, (_, index) =>
      candidate({
        candidateID: `candidate-${index + 1}`,
        index,
        files,
        diffStats: { files: 50, additions: 500, deletions: 100 },
        patch: `diff-${index}-${"y".repeat(5_000)}`,
        patchBytes: 5_000,
        text: "z".repeat(4_000),
        tests: {
          skipped: false,
          passed: true,
          exitCode: 0,
          stdout: "o".repeat(20_000),
          stderr: "e".repeat(20_000),
        },
      }),
    )
    const race: RaceRecord = {
      raceID: "race_budget",
      createdAt: 1,
      updatedAt: 2,
      targetDirectory: "C:/repo",
      mode: "worktrees",
      prompt: "implement it",
      base: "base",
      keepWorktrees: false,
      status: "completed",
      candidates,
      worktrees: [],
    }
    const shaped = shapeRace(race, DEFAULT_OPTIONS, rankCandidates(candidates))
    const bounded = boundOutputTotal({ ...shaped, state: "ok" }, 20_000) as Record<
      string,
      unknown
    >
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(20_000)
    expect(bounded.raceID).toBe("race_budget")
    expect(bounded.status).toBe("completed")
    const survivors = bounded.candidates as Array<Record<string, unknown>>
    expect(survivors.length).toBeGreaterThanOrEqual(1)
    expect(survivors[0]?.candidateID).toBe("candidate-1")
    expect(bounded.candidatesTruncated).toBe(true)
    expect(survivors[0]?.filesTruncated).toBe(true)

    const wrapped = boundOutputTotal(
      { race: shaped, state: "ok" },
      20_000,
    ) as Record<string, unknown>
    expect(JSON.stringify(wrapped).length).toBeLessThanOrEqual(20_000)
    expect((wrapped.race as Record<string, unknown>).raceID).toBe("race_budget")
    expect(
      ((wrapped.race as Record<string, unknown>).candidates as unknown[]).length,
    ).toBeGreaterThanOrEqual(1)
  })
})
