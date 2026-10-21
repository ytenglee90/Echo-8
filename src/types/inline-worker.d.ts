declare module '*?worker&inline' {
  const WorkerConstructor: {
    new (): Worker;
  };
  export default WorkerConstructor;
}

declare module '*?worker' {
  const WorkerConstructor: {
    new (): Worker;
  };
  export default WorkerConstructor;
}
