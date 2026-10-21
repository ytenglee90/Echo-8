declare module '*.js?raw' {
  const source: string;
  export default source;
}

declare module '*.sql?raw' {
  const source: string;
  export default source;
}

