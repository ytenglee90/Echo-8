import type { Metadata } from 'next';
import { PRODUCT_NAME } from '../src/product.ts';
import './globals.css';

export const metadata: Metadata = {
  title: `${PRODUCT_NAME} · 微内核无限画布`,
  description: '广播驱动、插件热拔插的无限画布工作区。',
  icons: { icon: '/favicon.svg' },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
