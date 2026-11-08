# Ketchup site

The landing page for Ketchup. Plain HTML, CSS and JavaScript with no build step; open `index.html` to preview.

## Publish on GitHub Pages

1. Push this folder to the `main` branch of a GitHub repository.
2. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**.
3. The `Deploy to GitHub Pages` workflow publishes the site on every push to `main`.

For a custom domain, add a `CNAME` file containing the domain and point its DNS at GitHub Pages. To show the GitHub link, put the repository URL in `data-repo` on the `<html>` tag; on a `github.io` address it is filled in automatically.
