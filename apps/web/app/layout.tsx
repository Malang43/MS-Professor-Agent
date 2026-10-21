import "./globals.css";
export const metadata = {
  title: "MS Professor Outreach Agent",
  description: "Your next research chapter starts here.",
};
export default function Layout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
