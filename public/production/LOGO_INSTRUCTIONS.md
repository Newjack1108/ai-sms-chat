# Logo Placement Instructions

## Where to Place Your Logo

Place your logo file named `logo.png` in the following directory:

```
public/production/logo.png
```

## Logo Specifications

### Header Logo (Navbar)
- **Recommended size**: 200px width × 40px height
- **Format**: PNG with transparency (preferred) or JPG
- **Aspect ratio**: Flexible, will auto-scale to 40px height
- **Location**: Appears in the navbar (header) on all production pages

### Background Logo (Dashboard)
- **Recommended size**: 800px × 800px (square or rectangular)
- **Format**: PNG with transparency (preferred) or JPG
- **Opacity**: Automatically set to 3% (very faded)
- **Location**: Centered behind dashboard content (dashboard.html only)

## Current Setup

The logo placeholder is already configured in:
- **Header**: All production pages (panels.html, planner.html, dashboard.html, etc.)
- **Background**: Dashboard page only (dashboard.html)

If the logo file is not found, the header will simply show the page title without the logo image.

## File Path

Full path from project root:
```
public/production/logo.png
```

Once you place the logo file, it will automatically appear in:
1. The navbar on all production pages
2. As a faded background watermark on the dashboard page

