import { Document, Page, Text, View, StyleSheet, renderToBuffer, Link } from "@react-pdf/renderer";
import { marked, type Token, type Tokens } from "marked";
import React from "react";

// Uses the PDF built-in Helvetica/Times faces so rendering never needs to
// fetch a font over the network.

const s = StyleSheet.create({
  page: { paddingTop: 56, paddingBottom: 64, paddingHorizontal: 56, fontFamily: "Times-Roman", fontSize: 11, lineHeight: 1.55, color: "#1a1a1a" },
  docTitle: { fontFamily: "Helvetica-Bold", fontSize: 24, marginBottom: 6, color: "#111" },
  byline: { fontFamily: "Helvetica", fontSize: 9, color: "#777", marginBottom: 22, borderBottomWidth: 1, borderBottomColor: "#e0e0e0", paddingBottom: 14 },
  h1: { fontFamily: "Helvetica-Bold", fontSize: 16, marginTop: 20, marginBottom: 8, color: "#111" },
  h2: { fontFamily: "Helvetica-Bold", fontSize: 13, marginTop: 16, marginBottom: 6, color: "#222" },
  h3: { fontFamily: "Helvetica-Bold", fontSize: 11.5, marginTop: 12, marginBottom: 4, color: "#333" },
  p: { marginBottom: 9, textAlign: "justify" },
  li: { flexDirection: "row", marginBottom: 5, paddingRight: 8 },
  bullet: { width: 16, fontFamily: "Helvetica" },
  liBody: { flex: 1 },
  quote: { borderLeftWidth: 3, borderLeftColor: "#ccc", paddingLeft: 12, marginVertical: 9, color: "#555", fontStyle: "italic" },
  code: { fontFamily: "Courier", fontSize: 9, backgroundColor: "#f5f5f5", padding: 10, marginVertical: 9 },
  hr: { borderBottomWidth: 1, borderBottomColor: "#e0e0e0", marginVertical: 14 },
  table: { marginVertical: 10, borderWidth: 1, borderColor: "#ddd" },
  tr: { flexDirection: "row" },
  th: { flex: 1, padding: 6, fontFamily: "Helvetica-Bold", fontSize: 9, backgroundColor: "#f2f2f2", borderRightWidth: 1, borderRightColor: "#ddd" },
  td: { flex: 1, padding: 6, fontSize: 9.5, borderTopWidth: 1, borderTopColor: "#eee", borderRightWidth: 1, borderRightColor: "#eee" },
  bold: { fontFamily: "Times-Bold" },
  italic: { fontFamily: "Times-Italic" },
  link: { color: "#1a5fb4", textDecoration: "underline" },
  footerLeft: { position: "absolute", bottom: 30, left: 56, fontFamily: "Helvetica", fontSize: 8, color: "#999" },
});

/** Renders marked inline tokens (bold, italic, code, links) into <Text> runs. */
function inline(tokens: Token[] | undefined, keyPrefix: string): React.ReactNode[] {
  if (!tokens) return [];
  return tokens.map((t, i) => {
    const k = `${keyPrefix}-${i}`;
    switch (t.type) {
      case "strong":
        return <Text key={k} style={s.bold}>{inline((t as Tokens.Strong).tokens, k)}</Text>;
      case "em":
        return <Text key={k} style={s.italic}>{inline((t as Tokens.Em).tokens, k)}</Text>;
      case "codespan":
        return <Text key={k} style={{ fontFamily: "Courier", fontSize: 9.5 }}>{(t as Tokens.Codespan).text}</Text>;
      case "link": {
        const link = t as Tokens.Link;
        return <Link key={k} src={link.href} style={s.link}>{link.text || link.href}</Link>;
      }
      case "br":
        return <Text key={k}>{"\n"}</Text>;
      default:
        return <Text key={k}>{(t as { text?: string }).text ?? ""}</Text>;
    }
  });
}

function blocks(md: string): React.ReactNode[] {
  const tokens = marked.lexer(md);
  const out: React.ReactNode[] = [];

  tokens.forEach((t, i) => {
    const k = `b-${i}`;
    switch (t.type) {
      case "heading": {
        const h = t as Tokens.Heading;
        const style = h.depth <= 1 ? s.h1 : h.depth === 2 ? s.h2 : s.h3;
        out.push(<Text key={k} style={style}>{inline(h.tokens, k)}</Text>);
        break;
      }
      case "paragraph":
        out.push(<Text key={k} style={s.p}>{inline((t as Tokens.Paragraph).tokens, k)}</Text>);
        break;
      case "list": {
        const list = t as Tokens.List;
        list.items.forEach((item, j) => {
          const marker = list.ordered ? `${Number(list.start || 1) + j}.` : "•";
          out.push(
            <View key={`${k}-${j}`} style={s.li} wrap={false}>
              <Text style={s.bullet}>{marker}</Text>
              <Text style={s.liBody}>{inline(item.tokens?.flatMap((x) => ("tokens" in x && x.tokens ? x.tokens : [x])) as Token[], `${k}-${j}`)}</Text>
            </View>
          );
        });
        break;
      }
      case "table": {
        const tbl = t as Tokens.Table;
        out.push(
          <View key={k} style={s.table}>
            <View style={s.tr}>
              {tbl.header.map((cell, c) => (
                <Text key={c} style={s.th}>{inline(cell.tokens, `${k}-h${c}`)}</Text>
              ))}
            </View>
            {tbl.rows.map((row, r) => (
              <View key={r} style={s.tr} wrap={false}>
                {row.map((cell, c) => (
                  <Text key={c} style={s.td}>{inline(cell.tokens, `${k}-${r}-${c}`)}</Text>
                ))}
              </View>
            ))}
          </View>
        );
        break;
      }
      case "blockquote":
        out.push(<Text key={k} style={s.quote}>{(t as Tokens.Blockquote).text}</Text>);
        break;
      case "code":
        out.push(<Text key={k} style={s.code}>{(t as Tokens.Code).text}</Text>);
        break;
      case "hr":
        out.push(<View key={k} style={s.hr} />);
        break;
      case "space":
        break;
      default: {
        const text = (t as { text?: string }).text;
        if (text?.trim()) out.push(<Text key={k} style={s.p}>{text}</Text>);
      }
    }
  });

  return out;
}

export async function renderReportPdf(title: string, markdown: string): Promise<Buffer> {
  const generated = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  const doc = (
    <Document title={title} author="MicroManus">
      <Page size="A4" style={s.page}>
        <Text style={s.docTitle}>{title}</Text>
        <Text style={s.byline}>Generated by MicroManus · {generated}</Text>
        {blocks(markdown)}
        <Text style={s.footerLeft} fixed>
          MicroManus research report
        </Text>
      </Page>
    </Document>
  );

  return renderToBuffer(doc);
}
