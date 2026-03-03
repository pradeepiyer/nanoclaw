#!/usr/bin/env node

// Fetch Yahoo Finance quotes using yahoo-finance2 (bypasses IP-based 429 blocks)
// Usage: node yf-quote.mjs AAPL,MSFT,GC=F,ES=F

import YahooFinance from "yahoo-finance2";
const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const symbols = process.argv[2];
if (!symbols) {
  console.error("Usage: node yf-quote.mjs SYMBOL1,SYMBOL2,...");
  process.exit(1);
}

const symbolList = symbols.split(",").map((s) => s.trim()).filter(Boolean);

try {
  const results = await yahooFinance.quote(symbolList);

  // Normalize to array (single symbol returns object)
  const quotes = Array.isArray(results) ? results : [results];

  const output = quotes.map((q) => ({
    symbol: q.symbol,
    regularMarketPrice: q.regularMarketPrice,
    regularMarketChange: q.regularMarketChange,
    regularMarketChangePercent: q.regularMarketChangePercent,
    marketState: q.marketState,
    regularMarketTime: q.regularMarketTime,
  }));

  console.log(JSON.stringify(output, null, 2));
} catch (err) {
  console.error("Error fetching quotes:", err.message);
  process.exit(1);
}
