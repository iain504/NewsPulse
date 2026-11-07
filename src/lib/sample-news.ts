/** Pre-loaded sample articles for one-click demos. */
export interface SampleNews {
  label: string;
  title: string;
  source: string;
  text: string;
}

export const SAMPLE_NEWS: SampleNews[] = [
  {
    label: "Markets rally",
    title: "Stocks surge as central bank signals rate cuts",
    source: "Market Wire",
    text: "Stocks rallied sharply on Tuesday after the central bank signaled it could begin cutting interest rates as early as next quarter. The benchmark index closed up 2.4% at a record high, led by technology and real estate shares. Bond yields fell and the dollar weakened as traders priced in easier policy. Analysts called the statement a decisive pivot that should ease borrowing costs for households and businesses through the year.",
  },
  {
    label: "OPEC cut",
    title: "Oil jumps 6% after surprise OPEC+ production cut",
    source: "Energy Daily",
    text: "Oil prices surged 6% today after OPEC+ announced an unexpected production cut of one million barrels per day, extending curbs through the summer. Energy stocks climbed on the news, but airlines and logistics firms fell on higher fuel cost concerns. Economists warned the move could re-ignite inflation just as central banks were gaining ground in their fight against rising prices, complicating the outlook for monetary policy.",
  },
  {
    label: "Layoffs",
    title: "Tech giant to cut 12,000 jobs amid slowing growth",
    source: "Tech Chronicle",
    text: "One of the world's largest technology companies said it will eliminate 12,000 jobs, about 8% of its workforce, as it grapples with slowing revenue growth and mounting losses in its hardware division. Employees were notified by email early Friday morning, with severance packages described as generous by some recipients and inadequate by others. The company's shares rose 3% in after-hours trading as investors welcomed the cost reductions.",
  },
  {
    label: "Neutral report",
    title: "Statistics office releases quarterly trade figures",
    source: "National Bureau",
    text: "The national statistics office on Monday published its quarterly trade report, recording exports of 412 billion units and imports of 408 billion units for the period. The modest surplus of 4 billion units compares with a deficit of 2 billion units in the previous quarter. The report also revised last quarter's growth figure from 0.6% to 0.5%. A full breakdown by sector will be made available on the office's website next week.",
  },
  {
    label: "Mixed signals",
    title: "Chipmaker beats earnings but warns of soft demand ahead",
    source: "Silicon Report",
    text: "The semiconductor company reported quarterly earnings that beat expectations by 14%, driven by strong data-center sales. However, management warned that consumer chip demand remains weak and said inventory corrections in the smartphone market could pressure results for two more quarters. The stock initially jumped 5% on the beat, then pared gains to close down 1% as analysts weighed the cautious guidance against the strong results.",
  },
];
