import { Suspense } from "react";
import type { Metadata } from "next";
import Script from "next/script";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "@copilotkit/react-core/v2/styles.css";
import { ThemeWrapper } from "@/components/theme-wrapper";
import { MainLayout } from "@/components/layout/main-layout";
import { URLParamsProvider } from "@/contexts/url-params-context";
import { PHProvider } from "@/components/posthog-provider";
import { ScarfPixel } from "@/components/scarf-pixel";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Demo Viewer by CopilotKit",
  description: "Demo Viewer by CopilotKit",
};

const REO_KEY = "f6eae27a6f1c6bb";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <Script
          id="hubspot-script"
          src="https://js.hs-scripts.com/45532593.js"
          type="text/javascript"
          strategy="lazyOnload"
        />
        <Script
          id="gtag-loader"
          src="https://www.googletagmanager.com/gtag/js?id=G-VLHBBW8BC9"
          strategy="lazyOnload"
        />
        <Script
          id="gtag-init"
          strategy="lazyOnload"
          dangerouslySetInnerHTML={{
            __html: `
              window.dataLayer = window.dataLayer || [];
              function gtag(){dataLayer.push(arguments);}
              gtag('js', new Date());
              gtag('config', 'G-VLHBBW8BC9');
            `,
          }}
        />
        <Script
          id="rb2b-script"
          strategy="lazyOnload"
          dangerouslySetInnerHTML={{
            __html: `!function () {var reb2b = window.reb2b = window.reb2b || [];if (reb2b.invoked) return;reb2b.invoked = true;reb2b.methods = ["identify", "collect"];reb2b.factory = function (method) {return function () {var args = Array.prototype.slice.call(arguments);args.unshift(method);reb2b.push(args);return reb2b;};};for (var i = 0; i < reb2b.methods.length; i++) {var key = reb2b.methods[i];reb2b[key] = reb2b.factory(key);}reb2b.load = function (key) {var script = document.createElement("script");script.type = "text/javascript";script.async = true;script.src = "https://b2bjsstore.s3.us-west-2.amazonaws.com/b/" + key + "/GOYPYHVD49OX.js.gz";var first = document.getElementsByTagName("script")[0];first.parentNode.insertBefore(script, first);};reb2b.SNIPPET_VERSION = "1.0.1";reb2b.load("GOYPYHVD49OX");}();`,
          }}
        />
        <Script
          id="reo-init-script"
          strategy="lazyOnload"
          dangerouslySetInnerHTML={{
            __html: `
              !function(){
                var e, t, n;
                e = "${REO_KEY}";
                t = function() {
                  if (window.Reo) {
                    window.Reo.init({ clientID: "${REO_KEY}", enableThirdPartyTracking: true });
                  }
                };
                n = document.createElement("script");
                n.src = "https://static.reo.dev/" + e + "/reo.js";
                n.defer = true;
                n.onload = t;
                document.head.appendChild(n);
              }();
            `,
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <PHProvider>
          <Suspense>
            <URLParamsProvider>
              <ThemeWrapper>
                <MainLayout>{children}</MainLayout>
              </ThemeWrapper>
            </URLParamsProvider>
          </Suspense>
          <ScarfPixel />
        </PHProvider>
      </body>
    </html>
  );
}
