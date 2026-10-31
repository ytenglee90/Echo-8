export function isSupportedDocumentFile(file: Blob & { name?: string }): boolean {
  const name = file.name?.toLocaleLowerCase() ?? '';
  return name.endsWith('.txt') || name.endsWith('.docx') || name.endsWith('.doc') ||
    file.type.startsWith('text/plain') ||
    file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
}
