import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Text-to-SQL Assistant",
  description:
    "Ask questions in plain English and get instant SQL queries and answers powered by AI.",
  keywords: ["text-to-sql", "ai", "sql", "database", "natural language"],
  openGraph: {
    title: "Text-to-SQL Assistant",
    description: "Ask questions in plain English and get instant SQL queries.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
