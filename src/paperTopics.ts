import { loadPdfjs } from "./PdfReader";
import { PAPER_TOPICS, type PaperTopic } from "./types";

// What a paper is about, read from its full text rather than one topic picked
// at upload. Eleven broad domains, each split into specific fields matched by
// regular expressions. Every pattern is a whole-word, case-insensitive match;
// phrases are preferred over single words so generic vocabulary ("model",
// "data", "system") can't decide a field on its own.
//
// Signals are stored per paper as {"Domain/Field": score} (see
// books.topic_signals) and the papers radar is built from them in
// worker/lib.rs paper_attributes(), so field labels must stay stable.

export const PAPER_DOMAINS = PAPER_TOPICS;
export type PaperDomain = PaperTopic;

type Field = { label: string; patterns: string[]; arxiv?: string[] };

export const TAXONOMY: Record<PaperDomain, Field[]> = {
  "Computer Science": [
    { label: "Machine Learning", arxiv: ["cs.LG", "stat.ML"], patterns: ["machine learning", "neural networks?", "deep learning", "gradient descent", "backpropagation", "training (?:set|data|loss)", "overfitting", "reinforcement learning", "supervised learning", "transformers?", "embeddings?", "fine-tun(?:e|ing)", "convolutional", "large language models?", "llms?", "diffusion models?", "generalization error"] },
    { label: "Natural Language Processing", arxiv: ["cs.CL"], patterns: ["natural language", "language models?", "machine translation", "tokeni[sz](?:er|ation)", "bleu", "named entit(?:y|ies)", "sentiment analysis", "question answering", "parsing", "corpus", "corpora", "word embeddings?", "summari[sz]ation"] },
    { label: "Computer Vision", arxiv: ["cs.CV"], patterns: ["computer vision", "image (?:classification|segmentation|recognition)", "object detection", "convolutional neural", "pixels?", "imagenet", "optical flow", "pose estimation", "3d reconstruction", "visual features?"] },
    { label: "Systems & Networking", arxiv: ["cs.DC", "cs.NI", "cs.OS", "cs.AR", "cs.PF"], patterns: ["distributed systems?", "latency", "throughput", "operating systems?", "kernel", "scheduler", "consensus", "fault[- ]toleran(?:t|ce)", "network protocols?", "tcp", "data ?cent(?:er|re)s?", "cloud computing", "virtual machines?", "caching", "gpus?"] },
    { label: "Security & Privacy", arxiv: ["cs.CR"], patterns: ["vulnerabilit(?:y|ies)", "exploits?", "attackers?", "threat model", "encryption", "cryptograph(?:y|ic)", "malware", "authentication", "differential privacy", "side[- ]channel", "adversarial examples?", "zero[- ]knowledge"] },
    { label: "Algorithms & Theory", arxiv: ["cs.DS", "cs.CC", "cs.DM", "cs.GT"], patterns: ["np-hard", "np-complete", "polynomial time", "approximation algorithms?", "time complexity", "lower bounds?", "upper bounds?", "graph algorithms?", "computational complexity", "turing machines?", "big-o", "dynamic programming", "randomi[sz]ed algorithms?"] },
    { label: "Databases & Data", arxiv: ["cs.DB", "cs.IR"], patterns: ["databases?", "query (?:processing|optimi[sz]ation)", "sql", "transactions?", "indexing", "information retrieval", "search engines?", "data management", "key-value stores?", "recommender systems?"] },
    { label: "Programming & Software", arxiv: ["cs.PL", "cs.SE", "cs.LO"], patterns: ["programming languages?", "type systems?", "compilers?", "static analysis", "formal verification", "program synthesis", "software engineering", "refactoring", "test(?:ing)? suites?", "semantics of", "lambda calculus"] },
    { label: "Human-Computer Interaction", arxiv: ["cs.HC", "cs.CY"], patterns: ["user stud(?:y|ies)", "usability", "participants", "interfaces?", "interaction design", "accessibility", "user experience", "think-aloud", "crowdsourc(?:e|ing)"] },
    { label: "Robotics & Autonomy", arxiv: ["cs.RO", "cs.MA", "cs.AI"], patterns: ["robots?", "robotic", "manipulat(?:or|ion)", "motion planning", "slam", "autonomous (?:vehicles?|driving|agents?)", "multi-agent", "path planning", "grasping"] },
  ],
  Mathematics: [
    { label: "Algebra", arxiv: ["math.AG", "math.RA", "math.GR", "math.RT", "math.AC", "math.CT"], patterns: ["abelian", "finite groups?", "group actions?", "polynomial rings?", "noetherian", "homomorphisms?", "isomorphisms?", "galois", "lie algebras?", "representation theory", "algebraic geometry", "category theory", "commutative algebra"] },
    { label: "Analysis", arxiv: ["math.AP", "math.CA", "math.FA", "math.CV"], patterns: ["banach spaces?", "hilbert spaces?", "sobolev", "partial differential equations?", "pdes?", "measure theory", "lebesgue", "functional analysis", "holomorphic", "fourier transforms?", "integral equations?", "convergence of"] },
    { label: "Geometry & Topology", arxiv: ["math.DG", "math.GT", "math.AT", "math.MG", "math.SG"], patterns: ["manifolds?", "topology", "topological", "homotopy", "homology", "curvature", "riemannian", "symplectic", "knots?", "simplicial", "differential geometry"] },
    { label: "Probability & Statistics", arxiv: ["math.PR", "math.ST", "stat.TH", "stat.ME"], patterns: ["random variables?", "stochastic processes?", "martingales?", "brownian motion", "markov chains?", "estimators?", "hypothesis test(?:s|ing)?", "bayesian", "likelihood", "confidence intervals?", "variance", "posterior"] },
    { label: "Number Theory & Combinatorics", arxiv: ["math.NT", "math.CO"], patterns: ["primes?", "prime numbers?", "modular forms?", "diophantine", "zeta functions?", "elliptic curves?", "combinatori(?:al|cs)", "graph theory", "partitions?", "generating functions?", "permutations?"] },
    { label: "Logic & Foundations", arxiv: ["math.LO"], patterns: ["set theory", "model theory", "proof theory", "axioms?", "zfc", "decidab(?:le|ility)", "first-order logic", "ordinals?", "cardinals?"] },
    { label: "Applied Math & Optimization", arxiv: ["math.OC", "math.NA", "math.DS"], patterns: ["optimi[sz]ation problems?", "convex", "linear programming", "numerical methods?", "finite elements?", "dynamical systems?", "bifurcations?", "chaos", "ordinary differential equations?", "odes?"] },
  ],
  Physics: [
    { label: "Quantum Physics", arxiv: ["quant-ph"], patterns: ["quantum", "qubits?", "entanglement", "superposition", "hamiltonians?", "wave ?functions?", "decoherence", "quantum computing", "schr[oö]dinger"] },
    { label: "Particles & Fields", arxiv: ["hep-th", "hep-ph", "hep-ex", "hep-lat", "nucl-th", "nucl-ex"], patterns: ["particles?", "quarks?", "bosons?", "fermions?", "gauge theor(?:y|ies)", "standard model", "lhc", "string theory", "neutrinos?", "nuclei", "nuclear physics", "feynman"] },
    { label: "Astrophysics & Cosmology", arxiv: ["astro-ph", "gr-qc"], patterns: ["galax(?:y|ies)", "cosmolog(?:y|ical)", "dark matter", "dark energy", "black holes?", "stars?", "stellar", "redshift", "telescopes?", "gravitational waves?", "exoplanets?", "big bang", "general relativity"] },
    { label: "Condensed Matter", arxiv: ["cond-mat"], patterns: ["condensed matter", "superconduct(?:or|ivity|ing)", "lattices?", "phonons?", "spin systems?", "band structure", "semiconductors?", "magnetism", "topological insulators?", "crystal"] },
    { label: "Optics & Photonics", arxiv: ["physics.optics"], patterns: ["optic(?:s|al)", "photons?", "lasers?", "photonic", "wavelengths?", "refractive index", "interferometr(?:y|ic)", "spectroscopy"] },
    { label: "Classical & Statistical Physics", arxiv: ["physics.flu-dyn", "physics.class-ph", "cond-mat.stat-mech"], patterns: ["fluid dynamics", "turbulence", "navier-stokes", "thermodynamics", "entropy", "statistical mechanics", "phase transitions?", "electrodynamics", "electromagnetic", "classical mechanics"] },
  ],
  "Life Sciences": [
    { label: "Genetics & Genomics", arxiv: ["q-bio.GN"], patterns: ["genes?", "genom(?:e|es|ic|ics)", "dna", "rna", "sequencing", "mutations?", "alleles?", "gene expression", "crispr", "chromosomes?", "transcription factors?"] },
    { label: "Molecular & Cell Biology", arxiv: ["q-bio.BM", "q-bio.SC", "q-bio.MN"], patterns: ["proteins?", "cells?", "cellular", "enzymes?", "receptors?", "signaling pathways?", "mitochondria", "membranes?", "protein folding", "molecular biology"] },
    { label: "Neuroscience", arxiv: ["q-bio.NC"], patterns: ["neurons?", "neural circuits?", "brain", "cortex", "cortical", "synap(?:se|ses|tic)", "neurotransmitters?", "fmri", "hippocampus", "cognition"] },
    { label: "Ecology & Evolution", arxiv: ["q-bio.PE"], patterns: ["ecolog(?:y|ical)", "evolution(?:ary)?", "species", "populations?", "biodiversity", "natural selection", "phylogen(?:y|etic)", "habitats?", "ecosystems?", "predators?"] },
    { label: "Microbiology & Immunology", patterns: ["bacteria", "bacterial", "virus(?:es)?", "viral", "pathogens?", "immune", "antibod(?:y|ies)", "antigens?", "t cells?", "microbiome", "infection"] },
    { label: "Bioinformatics", arxiv: ["q-bio.QM"], patterns: ["bioinformatics", "computational biology", "sequence alignment", "protein structure prediction", "single-cell", "phylogenetic trees?", "gene regulatory networks?"] },
  ],
  "Medicine & Health": [
    { label: "Clinical Research", patterns: ["clinical trials?", "randomi[sz]ed controlled", "patients?", "placebo", "cohort", "treatment groups?", "outcomes?", "hospital", "diagnos(?:is|ed|tic)"] },
    { label: "Epidemiology & Public Health", patterns: ["epidemiolog(?:y|ical)", "public health", "prevalence", "incidence", "mortality", "pandemic", "transmission", "vaccin(?:e|es|ation)", "risk factors?", "population health"] },
    { label: "Oncology", patterns: ["cancers?", "tumou?rs?", "oncolog(?:y|ical)", "chemotherapy", "metasta(?:sis|tic)", "carcinoma", "malignan(?:t|cy)"] },
    { label: "Mental Health", patterns: ["depression", "anxiety", "psychiatr(?:y|ic)", "mental health", "schizophrenia", "ptsd", "therapy sessions?", "wellbeing", "well-being"] },
    { label: "Pharmacology", patterns: ["drugs?", "dosage", "pharmacokinetics?", "pharmacolog(?:y|ical)", "adverse events?", "efficacy", "compounds?", "inhibitors?"] },
  ],
  "Chemistry & Materials": [
    { label: "Chemistry", arxiv: ["physics.chem-ph"], patterns: ["molecules?", "molecular", "reactions?", "catalys(?:t|ts|is)", "synthesis", "solvents?", "bonds?", "chemical", "spectra", "organic", "polymers?"] },
    { label: "Materials Science", arxiv: ["cond-mat.mtrl-sci"], patterns: ["materials? science", "alloys?", "nanoparticles?", "thin films?", "graphene", "ceramics?", "composites?", "microstructure", "nanomaterials?"] },
    { label: "Biochemistry", patterns: ["biochemi(?:stry|cal)", "metabolism", "metabolic", "amino acids?", "atp", "enzyme kinetics", "lipids?"] },
  ],
  "Earth & Environment": [
    { label: "Climate Science", arxiv: ["physics.ao-ph"], patterns: ["climate", "global warming", "greenhouse gas(?:es)?", "carbon dioxide", "co2", "emissions", "temperature anomal(?:y|ies)", "precipitation", "ipcc"] },
    { label: "Earth Sciences", arxiv: ["physics.geo-ph"], patterns: ["geolog(?:y|ical)", "seismic", "earthquakes?", "tectonic", "sediments?", "volcan(?:o|ic|oes)", "geophysic(?:s|al)", "oceans?", "oceanograph(?:y|ic)"] },
    { label: "Energy & Sustainability", patterns: ["renewable", "solar", "wind power", "energy storage", "batter(?:y|ies)", "sustainab(?:le|ility)", "electricity grid", "fossil fuels?", "decarboni[sz]ation"] },
  ],
  Engineering: [
    { label: "Electrical Engineering", arxiv: ["eess.SP", "eess.SY"], patterns: ["circuits?", "signal processing", "voltage", "transistors?", "antennas?", "wireless", "power electronics", "filters?", "frequency response"] },
    { label: "Control & Systems", arxiv: ["eess.SY", "math.OC"], patterns: ["control theory", "controllers?", "feedback control", "pid", "stability analysis", "state space", "kalman filters?", "model predictive control"] },
    { label: "Mechanical & Civil", patterns: ["stress-strain", "tensile", "yield strength", "finite element", "structural engineering", "beams?", "load-bearing", "vibrations?", "aerodynamic", "heat transfer", "mechanical engineering"] },
  ],
  "Economics & Finance": [
    { label: "Microeconomics", arxiv: ["econ.TH"], patterns: ["consumers?", "firms?", "markets?", "auctions?", "game theory", "equilibri(?:um|a)", "utility", "incentives?", "mechanism design", "pricing"] },
    { label: "Macroeconomics", arxiv: ["econ.GN"], patterns: ["inflation", "monetary policy", "fiscal policy", "gdp", "unemployment", "interest rates?", "central banks?", "business cycles?", "recession"] },
    { label: "Econometrics", arxiv: ["econ.EM"], patterns: ["econometric(?:s)?", "regressions?", "instrumental variables?", "difference-in-differences", "panel data", "causal (?:effect|inference)", "identification strategy", "fixed effects"] },
    { label: "Finance", arxiv: ["q-fin"], patterns: ["asset pricing", "portfolios?", "stock (?:market|returns|prices)", "excess returns", "volatility", "options pricing", "investors?", "banking", "credit risk", "risk premi(?:um|a)", "hedge funds?"] },
    { label: "Development & Labor", patterns: ["developing countries", "poverty", "labou?r markets?", "wages?", "income inequality", "education outcomes", "migration", "households?"] },
  ],
  "Social Sciences": [
    { label: "Psychology", patterns: ["psycholog(?:y|ical)", "behavio(?:u)?r(?:al)?", "cognitive", "perception", "personality", "emotions?", "experiments? with participants", "memory recall"] },
    { label: "Sociology", patterns: ["social networks?", "inequality", "communit(?:y|ies)", "institutions?", "social class", "ethnograph(?:y|ic)", "gender", "race", "interviews"] },
    { label: "Political Science", patterns: ["elections?", "voters?", "voting", "democrac(?:y|ies)", "parliament", "political parties", "policy makers?", "governance", "international relations", "legislat(?:ion|ive)"] },
    { label: "Education", patterns: ["students?", "teachers?", "classroom", "curricul(?:um|a)", "learning outcomes", "pedagog(?:y|ical)", "schools?", "universit(?:y|ies)"] },
    { label: "Linguistics", patterns: ["linguistic(?:s)?", "phonolog(?:y|ical)", "syntax", "morpholog(?:y|ical)", "semantics", "pragmatics", "dialects?", "grammar"] },
  ],
  Humanities: [
    { label: "Philosophy", patterns: ["philosoph(?:y|ical)", "ethics", "ethical", "epistemolog(?:y|ical)", "metaphysics", "ontolog(?:y|ical)", "moral", "kant", "aristotle", "consciousness"] },
    { label: "History", patterns: ["historiograph(?:y|ical)", "historians?", "(?:sixteenth|seventeenth|eighteenth|nineteenth|twentieth)[- ]century", "archival", "empires?", "colonial(?:ism)?", "medieval", "antiquity", "dynast(?:y|ies)"] },
    { label: "Literature", patterns: ["novels?", "novelists?", "poetry", "poems?", "poets?", "literary", "fiction", "rhetoric", "prose"] },
    { label: "Arts & Music", patterns: ["art history", "artworks?", "paintings?", "music(?:al)?", "aesthetics?", "film", "cinema", "architecture"] },
    { label: "Religion", patterns: ["religio(?:n|us)", "theolog(?:y|ical)", "scripture", "church", "islam(?:ic)?", "buddhis(?:m|t)", "christian(?:ity)?"] },
  ],
};

const compiled = Object.entries(TAXONOMY).flatMap(([domain, fields]) =>
  fields.map((f) => ({
    key: `${domain}/${f.label}`,
    domain: domain as PaperDomain,
    re: new RegExp(`\\b(?:${f.patterns.join("|")})\\b`, "gi"),
    arxiv: f.arxiv ?? [],
  })),
);

// arXiv's first-page stamp, e.g. "arXiv:1706.03762v7 [cs.CL] 2 Aug 2023".
const ARXIV_STAMP = /\[((?:cs|math|stat|econ|eess|q-bio|q-fin|astro-ph|cond-mat|gr-qc|hep-(?:th|ph|ex|lat)|nucl-(?:th|ex)|quant-ph|physics|nlin)(?:\.[A-Za-z-]+)?)\]/;

export type PaperAnalysis = {
  // Top fields, scores summing to ~100: {"Computer Science/Machine Learning": 41, ...}
  signals: Record<string, number>;
  domain: PaperDomain | null;
  arxivCategory: string | null;
};

// Scores every field against the paper's text. The first page (title and
// abstract) counts triple, each page's hits per field are capped so one
// repetitive section can't dominate, and an arXiv category stamp is a strong
// direct vote for its field.
export function analyzePaperText(pages: string[]): PaperAnalysis {
  const raw = new Map<string, number>();
  pages.forEach((text, i) => {
    const weight = i === 0 ? 3 : 1;
    for (const field of compiled) {
      const hits = text.match(field.re)?.length ?? 0;
      if (hits) raw.set(field.key, (raw.get(field.key) ?? 0) + weight * Math.min(hits, 12));
    }
  });
  const stamp = pages[0]?.match(ARXIV_STAMP)?.[1] ?? null;
  if (stamp) {
    const exact = compiled.filter((f) => f.arxiv.includes(stamp));
    const prefix = compiled.filter((f) => f.arxiv.some((a) => stamp.startsWith(a) || a.startsWith(stamp.split(".")[0] + ".")));
    for (const f of exact.length ? exact : prefix.slice(0, 1)) raw.set(f.key, (raw.get(f.key) ?? 0) + 60);
  }
  const ranked = [...raw.entries()].sort((a, b) => b[1] - a[1]);
  // Keep fields with a meaningful share of the strongest one.
  const top = ranked.filter(([, v], i) => i < 10 && v >= ranked[0][1] * 0.12);
  const total = top.reduce((s, [, v]) => s + v, 0) || 1;
  const signals = Object.fromEntries(top.map(([k, v]) => [k, Math.max(1, Math.round((100 * v) / total))]));
  const domainTotals = new Map<PaperDomain, number>();
  for (const [k, v] of top) {
    const d = k.split("/")[0] as PaperDomain;
    domainTotals.set(d, (domainTotals.get(d) ?? 0) + v);
  }
  const domain = [...domainTotals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { signals, domain, arxivCategory: stamp };
}

// Reads the whole paper (up to a generous page cap) with pdf.js.
export async function extractPdfText(data: ArrayBuffer, maxPages = 60): Promise<string[]> {
  const pdfjsLib = await loadPdfjs();
  const task = pdfjsLib.getDocument({ data });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      pages.push(content.items.map((it) => ("str" in it ? it.str : "")).join(" "));
    }
    return pages;
  } finally {
    void task.destroy();
  }
}

export async function analyzePdf(data: ArrayBuffer): Promise<PaperAnalysis> {
  return analyzePaperText(await extractPdfText(data));
}

export function parseSignals(raw?: string | null): [string, number][] {
  try {
    const parsed = JSON.parse(raw || "{}") as Record<string, number>;
    return Object.entries(parsed)
      .filter(([k, v]) => k.includes("/") && v > 0)
      .sort((a, b) => b[1] - a[1]);
  } catch {
    return [];
  }
}
