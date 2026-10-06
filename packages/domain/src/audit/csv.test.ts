import { describe, expect, it } from "vitest";
import { AUDIT_CSV_HEADERS, CSV_BOM, auditCsvHeader, auditCsvRow, csvCell, csvLine } from "./csv.ts";

describe("csvCell (RFC 4180, her hücre tırnaklı)", () => {
  it("düz metin tırnaklanır; null/undefined boş tırnaklı", () => {
    expect(csvCell("abc")).toBe('"abc"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
  });
  it("virgül, noktalı virgül, tırnak, CR/LF içeren hücre tek hücre kalır; tırnak ikilenir", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("a;b")).toBe('"a;b"');
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell("a\r\nb")).toBe('"a\r\nb"');
  });
  it("Türkçe karakterler bozulmaz", () => {
    expect(csvCell("Şükrü İğdır")).toBe('"Şükrü İğdır"');
  });
});

describe("CSV/formül enjeksiyonu", () => {
  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx", "＝1+1", "＋1", "－1", "＠SUM(A1)", " =1+1", "  \u00a0=cmd", "\u0001=x", "\n=x"])(
    "%j başlangıcı kaçışlanır",
    (v) => {
      expect(csvCell(v).startsWith(`"'`)).toBe(true);
    },
  );
  it("kaçış öneki RFC kaçışıyla birleşir; `;` ile bölünse bile ayrı hücre formül olmaz", () => {
    expect(csvCell('=HYPERLINK("x","y")')).toBe(`"'=HYPERLINK(""x"",""y"")"`);
    expect(csvCell("x;=cmd()")).toBe('"x;=cmd()"');
  });
  it("ortada geçen formül karakteri ve düz metin değiştirilmez", () => {
    expect(csvCell("a=b")).toBe('"a=b"');
    expect(csvCell("x-1")).toBe('"x-1"');
    expect(csvCell("{}")).toBe('"{}"');
  });
});

describe("satır/başlık", () => {
  it("BOM ve TR başlıklar, CRLF", () => {
    expect(CSV_BOM).toBe("﻿");
    expect(auditCsvHeader()).toBe(`${AUDIT_CSV_HEADERS.map((h) => `"${h}"`).join(",")}\r\n`);
    expect(AUDIT_CSV_HEADERS[0]).toBe("Tarih (UTC)");
  });
  it("csvLine hücreleri ayırır", () => {
    expect(csvLine(["a", null, "b,c"])).toBe('"a","","b,c"\r\n');
  });
  it("auditCsvRow yalnızca kartın sütunlarını yazar; kişi adı formülse kaçışlanır", () => {
    const line = auditCsvRow({
      occurredAt: new Date("2026-01-02T03:04:05.000Z"),
      actorName: "=cmd",
      action: "member.invited",
      entityType: "invitation",
      entityId: "id1",
      reason: null,
      changeSummary: '{"role_key":"PICKER"}',
    });
    expect(line).toBe(`"2026-01-02T03:04:05.000Z","'=cmd","member.invited","invitation","id1","","{""role_key"":""PICKER""}"\r\n`);
  });
});
