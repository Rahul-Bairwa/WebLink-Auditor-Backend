import axios from 'axios';
import xml2js from 'xml2js';
import * as cheerio from 'cheerio';
import https from 'https';
import express from 'express';
import cors from 'cors';
const app = express();
const port = 5200;
app.use(cors({
  origin: '*',
  methods: 'GET,POST',
  allowedHeaders: 'Content-Type',
}));
app.use(express.json());

const axiosInstance = axios.create({
  timeout: 30000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  },
  httpsAgent: new https.Agent({
    keepAlive: true, // Reuse connections
  }),
});

const excludedPatterns = [
  /wp-json/,
  /xmlrpc\.php/,
  /wp-admin/,
  /wp-login\.php/,
  /feed/,
  /comment/,
  /\/wp-includes\//,
  /\/wp-content\//,
  /\.json$/,
  /\.xml$/,
];

const isExcludedUrl = (url) => {
  return excludedPatterns.some((pattern) => pattern.test(url));
};

const visitedUrls = new Set();
app.get('/static-data', (req, res) => {
  res.json({
    message: "This is some static data",
    data: [
      { id: 1, name: "John Doe", role: "Admin" },
      { id: 2, name: "Jane Smith", role: "User" },
      { id: 3, name: "Alice Johnson", role: "Editor" }
    ]
  });
});
app.get("/check-links-stream", async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  const { url } = req.query;
  const cleanedUrl = url.endsWith("/") ? url.slice(0, -1) : url;

  if (!url) {
    return res.status(400).json({ error: "Site URL is required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const pages = await fetchSitemap(cleanedUrl); // Fetch all pages from the sitemap
    const totalPages = pages.length; // Total number of pages to process
    const brokenLinks = [];

    // Send the total number of pages initially
    res.write(
      `data: ${JSON.stringify({
        status: "init",
        totalPages: totalPages,
      })}\n\n`
    );

    for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
      const pageUrl = pages[pageIndex];
      try {
        if (typeof pageUrl !== "string" || !pageUrl.startsWith("http")) {
          console.warn(`Skipping invalid URL: ${pageUrl}`);
          continue;
        }

        console.log(`Processing page: ${pageUrl}`);

        // Fetch the HTML content of the page
        const pageResponse = await axiosInstance.get(pageUrl);
        const $ = cheerio.load(pageResponse.data);

        // Extract all links
        const elements = $("a, img, iframe, script, link");
        const pageLinksCount = elements.length;

        for (let i = 0; i < elements.length; i++) {
          const href = $(elements[i]).attr("href") || $(elements[i]).attr("src");
          const linkText =
            $(elements[i]).text().trim() ||
            $(elements[i]).attr("alt") ||
            "No text";

          if (
            href &&
            !href.startsWith("#") &&
            !href.startsWith("data:image/") &&
            !href.startsWith("mailto:") &&
            !href.startsWith("javascript:") &&
            !href.startsWith("tel:") &&
            !href.startsWith("about:blank") &&
            !isExcludedUrl(href) &&
            !/\.(css|js|woff2?|ttf|eot|png|jpg|jpeg|gif|svg|ico)$/.test(href) &&
            !/\?ver=/.test(href)
          ) {
            const fullUrl = href.startsWith("http")
              ? href
              : new URL(href, pageUrl).href;

            if (visitedUrls.has(fullUrl)) {
              console.log(`Skipping already visited URL: ${fullUrl}`);
              continue;
            }

            // Check if the link is broken
            const { isBroken, statusCode } = await checkLink(fullUrl);

            if (isBroken) {
              console.log(`Broken link found: ${fullUrl} on page: ${pageUrl}`);
              brokenLinks.push({
                pageUrl,
                link: fullUrl,
                linkText, // Add link text here
                statusCode,
              });
            }

            if (!isBroken) {
              visitedUrls.add(fullUrl);
            }
          }
        }

        // Send progress update with the number of links processed
        res.write(
          `data: ${JSON.stringify({
            status: "checked",
            page: pageUrl,
            links: pageLinksCount,
            processedPages: pageIndex + 1,
          })}\n\n`
        );
      } catch (error) {
        console.error(`Error processing page ${pageUrl}:`, error);
      }
    }

    // Send completion signal
    res.write(`data: ${JSON.stringify({ status: "completed", brokenLinks })}\n\n`);
    res.end();
  } catch (error) {
    console.error("Error:", error);
    res.write(`data: ${JSON.stringify({ status: "error", message: error.message })}\n\n`);
    res.end();
  }
});

function normalizeUrl(url) {
  if (url.startsWith("https://www.")) {
    return url.replace("https://www.", "https://");
  }
  else if (url.startsWith("https://") && !url.startsWith("https://www.")) {
    return url.replace("https://", "https://www.");
  }
  return url;
}

async function fetchSitemap(url) {
  const BASE_URLS = [url, normalizeUrl(url)];
  for (let BASE_URL of BASE_URLS) {
    try {

      // Append /sitemap.xml to the base URL to get the sitemap index
      const sitemapUrl = `${BASE_URL}/sitemap.xml`;

      // Fetch the sitemap index XML
      const response = await axios.get(sitemapUrl);

      // Parse the XML response
      const parser = new xml2js.Parser();
      return new Promise((resolve, reject) => {
        parser.parseString(response.data, async (err, result) => {
          if (err) {
            reject('Error parsing XML: ' + err);
          }

          // Extract the URLs of the sitemaps from sitemapindex
          if (result && result.sitemapindex && result.sitemapindex.sitemap) {
            const sitemapUrls = result.sitemapindex.sitemap.map((entry) => entry.loc[0]);
            console.log('Sitemap URLs:', sitemapUrls);

            // Now, for each sitemap URL, fetch and collect all the pages
            const allPages = [];
            for (let sitemapUrl of sitemapUrls) {
              await fetchPagesFromSitemap(sitemapUrl, allPages);
            }

            resolve(allPages); // Fixed: Return allPages correctly
          } else {
            reject('No sitemap URLs found in the sitemapindex.');
          }
        });
      });
    } catch (error) {
      console.log(`Sitemap not found at ${BASE_URL}, trying next...`);
    }
  }
  throw new Error("Your site doesn't have a sitemap.");

}

// Function to fetch pages from a single sitemap
async function fetchPagesFromSitemap(sitemapUrl, allPages) {
  try {
    const response = await axios.get(sitemapUrl);
    const xmlData = response.data;

    // Parse the individual sitemap XML
    const parser = new xml2js.Parser();
    return new Promise((resolve, reject) => {
      parser.parseString(xmlData, (err, result) => {
        if (err) {
          reject('Error parsing XML from sitemap: ' + err);
        }

        // Extract pages from the sitemap
        if (result && result.urlset && result.urlset.url) {
          const pages = result.urlset.url.map((item) => item.loc[0]);
          console.log(`Fetched Pages from ${sitemapUrl}:`, pages);

          pages.forEach((page) => {
            if (typeof page === 'string' && page.startsWith('http')) {
              allPages.push(page);
            } else {
              console.warn(`Skipping invalid page: ${page}`);
            }
          });

          resolve();
        } else {
          reject('No pages found in sitemap.');
        }
      });
    });
  } catch (error) {
    console.error(`Error fetching pages from ${sitemapUrl}:`, error);
  }
}

// Function to check if a link is broken
async function checkLink(url) {
  try {
    const response = await axiosInstance.get(url, {
      maxRedirects: 5,
      validateStatus: (status) => status < 500,
    });

    const isBroken = response.status === 404 || response.status >= 500;
    return { isBroken, statusCode: response.status };
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return { isBroken: true, statusCode: 404 };
    }
    console.error(`Error checking link: ${url}`, error.message);
    return { isBroken: false, statusCode: error.response ? error.response.status : 500 };
  }
}

// Start the server
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
