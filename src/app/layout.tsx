import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Barbify — gestão para barbearias", description: "Plataforma de gestão multi-barbearia" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
