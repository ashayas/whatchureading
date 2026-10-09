import { chromium, webkit, expect } from "@playwright/test";
import fs from "node:fs";
import {
  base,
  createTestUser,
  cleanupTestUsers,
  recoveryLink,
} from "./auth-test-helpers.mjs";
fs.mkdirSync("artifacts", { recursive: true });
const browser = await (
  process.env.TEST_BROWSER === "webkit" ? webkit : chromium
).launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  const user = await createTestUser();
  await page.goto(base);
  await expect(page.getByLabel("Your email", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "artifacts/auth-email-desktop.png",
    fullPage: true,
  });
  for (const width of [320, 390, 430, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByLabel("Your email", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      await page
        .getByLabel("Your email", { exact: true })
        .evaluate((el) => getComputedStyle(el).fontSize),
    ).toBe(width <= 700 ? "16px" : "14px");
    if (width === 390)
      await page.screenshot({
        path: "artifacts/auth-email-mobile.png",
        fullPage: true,
      });
  }
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Your email", { exact: true }).fill(user.email);
  await page.getByRole("button", { name: "Turn the page" }).click();
  await expect(page.getByLabel("Your password", { exact: true })).toBeEnabled();
  await page.screenshot({
    path: "artifacts/auth-password-desktop.png",
    fullPage: true,
  });
  await page
    .getByLabel("Your password", { exact: true })
    .fill("intentionally-wrong-password");
  await page.getByRole("button", { name: "Open my book" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Invalid login credentials",
  );
  await page.getByLabel("Your password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Open my book" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Your shelves are on their way",
  );
  await page.screenshot({
    path: "artifacts/auth-flipping.png",
    fullPage: true,
  });
  await expect(page.locator(".app-shell")).toBeVisible();
  // Real accounts start empty. Seed only this disposable account for existing feature checks.
  for (const [book_id, status, progress] of [
    ["midnight", "reading", 142],
    ["creative", "reading", 86],
    ["atomic", "read", 320],
    ["educated", "read", 352],
    ["normal", "read", 288],
    ["dune", "want", 0],
    ["piranesi", "want", 0],
  ]) {
    const response = await fetch(base + "/api/v1/library", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${user.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ book_id, status, page: progress }),
    });
    expect(response.status).toBe(200);
  }
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "A good day for a new chapter." }),
  ).toBeVisible();
  await page.screenshot({ path: "artifacts/feed-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Update progress" }).first().click();
  const readingTitle = await page.locator(".book-modal-header h2").innerText();
  await page.getByRole("spinbutton", { name: "Current page" }).fill("167");
  await page
    .getByRole("button", { name: "Save progress", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Progress saved");
  await page
    .getByPlaceholder("A line that stayed with you? A theory? A feeling?")
    .fill("A browser-tested thought.");
  await page
    .getByRole("button", { name: "Leave a thought", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("A thought, saved");
  await page
    .getByRole("button", { name: "Your thoughts", exact: false })
    .filter({ hasText: "Your thoughts" })
    .last()
    .click();
  await expect(
    page
      .getByRole("dialog")
      .getByText("A browser-tested thought.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Final verdict", exact: true })
    .click();
  await page.getByRole("button", { name: "Rate 4 stars", exact: true }).click();
  await page
    .getByPlaceholder("What will you remember about this book?")
    .fill("A very good chapter.");
  await page.getByRole("button", { name: "Finish & save verdict" }).click();
  await expect(page.getByRole("status")).toContainText("Your final verdict");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "A good day for a new chapter." }),
  ).toBeVisible();
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Discover", exact: true })
    .click();
  await expect(page.locator(".swipe-card h2")).toBeVisible();
  await page.screenshot({
    path: "artifacts/discover-desktop.png",
    fullPage: true,
  });
  const first = await page.locator(".swipe-card h2").innerText();
  await page.getByRole("button", { name: "Want to read", exact: true }).click();
  await expect(page.locator(".swipe-card h2")).not.toHaveText(first);
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Your library", exact: false })
    .click();
  await page.getByRole("button", { name: "Finished", exact: false }).click();
  await expect(page.getByText(readingTitle, { exact: true })).toBeVisible();
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Your profile", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Stories shape us." }),
  ).toBeVisible();
  await page.screenshot({
    path: "artifacts/profile-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator(".mobile-nav")
    .getByRole("button", { name: "The feed" })
    .click();
  await expect(
    page.getByRole("heading", { name: "A good day for a new chapter." }),
  ).toBeVisible();
  await page.screenshot({ path: "artifacts/feed-mobile.png", fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .locator(".mobile-nav")
    .getByRole("button", { name: "Discover" })
    .click();
  await page.screenshot({
    path: "artifacts/discover-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.locator(".search-box").click();
  const searchResponse = page.waitForResponse((r) =>
    r.url().includes("/api/v1/search?"),
  );
  await page.getByPlaceholder("Search a title or author…").fill("The Hobbit");
  expect([200, 502]).toContain((await searchResponse).status());
  await expect(
    page.getByRole("heading", { name: "From Open Library" }),
  ).toBeVisible();
  await page.waitForTimeout(4000);
  await page.screenshot({
    path: "artifacts/search-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page
    .locator(".mobile-nav")
    .getByRole("button", { name: "profile", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit profile" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByLabel("Your email", { exact: true })).toBeVisible();
  // Actual one-use recovery link, no email sent. Exercise the hosted callback + password update.
  await page.goto(await recoveryLink(user.email));
  await expect(page.getByLabel("New password", { exact: true })).toBeVisible();
  await page
    .getByLabel("New password", { exact: true })
    .fill("New!" + user.password);
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page.locator(".app-shell")).toBeVisible();
  // Persisted session survives reload; reduced motion and very narrow phone still fit.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 740 });
  await page.reload();
  await expect(page.locator(".app-shell")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  // Published source has no catalog export. An empty installation must still render.
  await page.route("**/api/v1/bootstrap", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      response,
      json: { ...data, books: [], library: [], notes: [], recommendations: [] },
    });
  });
  await page.goto(base);
  await expect(page.locator(".app-shell")).toBeVisible();
  for (const name of ["Discover", "library", "profile", "The feed"]) {
    await page
      .locator(".mobile-nav")
      .getByRole("button", { name, exact: true })
      .click();
    await expect(page.locator(".app-shell")).toBeVisible();
  }
  expect(errors).toEqual([]);
} finally {
  await browser.close();
  await cleanupTestUsers();
}
console.log(
  "PASS: mobile auth layouts, email/password pages, wrong-password errors, animated sign-in, sign-out, recovery callback, session restoration, browser progress, thoughts, verdict, refresh persistence, swipe, library, profile, mobile widths, and search UI.",
);
