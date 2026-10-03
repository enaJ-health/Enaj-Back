import { NextResponse } from "next/server";

// The three Open Facts databases — same API, different domains
const DATABASES = {
    food: "https://us.openfoodfacts.org",
    beauty: "https://us.openbeautyfacts.org",
    products: "https://us.openproductsfacts.org",
  };
const USDA_API_KEY = process.env.USDA_API_KEY;

// GET /api/product-search?q=nutella&source=food&page=1&pageSize=20
// GET /api/product-search?q=shampoo&source=beauty
// GET /api/product-search?q=shampoo&source=all  (searches all databases)
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const raw = searchParams.get("q") || ''
    const query = raw
      .toLowerCase()
      .trim()
      .replace(/[''`]/g, '')        // remove apostrophes
      .replace(/s\b/g, '')          // remove trailing 's' (plurals)
      .replace(/\s+/g, ' ')         // normalize spaces
      .trim()
    const source = searchParams.get("source") || "all";
    const category = searchParams.get("category") || "";
    const page = searchParams.get("page") || "1";
    const pageSize = searchParams.get("pageSize") || "20";
    const includeUSDA = category === "food";

    if (!query) {
      return NextResponse.json(
        { error: "q query parameter is required" },
        { status: 400 }
      );
    }

    let databasesToSearch: { name: string; url: string }[] = [];

    if (source === "all") {
        databasesToSearch = [
          { name: "food", url: DATABASES.food },
          { name: "beauty", url: DATABASES.beauty },
          { name: "products", url: DATABASES.products },
        ];
    } else if (source === "food") {
      databasesToSearch = [{ name: "food", url: DATABASES.food }];
    } else if (source === "products") {
        databasesToSearch = [{ name: "products", url: DATABASES.products }];
    } else if (source === "beauty") {
      databasesToSearch = [{ name: "beauty", url: DATABASES.beauty }];
    } else {
      return NextResponse.json(
        { error: "source must be 'food', 'beauty', or 'all'" },
        { status: 400 }
      );
    }

    let totalCount = 0;

    const [usdaResults, dbResultsArrays] = await Promise.all([
      includeUSDA ? searchUSDA(query) : Promise.resolve([]),
      Promise.all(
        databasesToSearch.map(async (db) => {
          const url = new URL(`${db.url}/cgi/search.pl`);
          url.searchParams.set("search_terms", query);
          url.searchParams.set("json", "true");
          url.searchParams.set("fields", "code,product_name,brands,ingredients_text,image_url,packaging_text_en,categories_tags_en,allergens_tags");
          url.searchParams.set("page", page);
          url.searchParams.set("page_size", "20");
          url.searchParams.set("action", "process");

          try {
            const response = await fetch(url.toString(), {
              headers: { "User-Agent": "Enaj/1.0 (https://enaj.app)" },
            });

            if (!response.ok) return { products: [] as any[], count: 0 };

            const data = await response.json();
            const products = (data.products || [])
              .filter((p: any) => p.product_name)
              .map((p: any) => ({
                barcode: p.code || null,
                name: p.product_name || "Unknown Product",
                brand: p.brands || "Unknown Brand",
                image: p.image_url || "",
                ingredients: parseIngredients(p.ingredients_text),
                packaging: parsePackaging(p.packaging_text_en),
                allergens: parseAllergens(p.allergens_tags),
                category: mapCategory(p.categories_tags_en, db.name),
                source: db.name,
              }));

            return { products, count: data.count || 0 };
          } catch (err) {
            console.error(`Error fetching from ${db.name}:`, err);
            return { products: [] as any[], count: 0 };
          }
        })
      ),
    ]);

    const allProducts: any[] = [...usdaResults];
    totalCount += usdaResults.length;

    for (const { products, count } of dbResultsArrays) {
      allProducts.push(...products);
      totalCount += count;
    }

    // If no results, retry with just the first word (broader search)
    if (allProducts.length === 0 && query.includes(" ")) {
        const firstWord = query.split(" ")[0];
        for (const db of databasesToSearch) {
          const url = new URL(`${db.url}/cgi/search.pl`);
          url.searchParams.set("search_terms", query);
          url.searchParams.set("json", "true");
          url.searchParams.set("fields", "code,product_name,brands,ingredients_text,image_url,packaging_text_en,categories_tags_en,allergens_tags");
          url.searchParams.set("page", page);
          url.searchParams.set("page_size", "20");
          url.searchParams.set("action", "process");
  
          try {
            const response = await fetch(url.toString(), {
              headers: { "User-Agent": "Enaj/1.0 (https://enaj.app)" },
            });
  
            if (response.ok) {
              const data = await response.json();
              totalCount += data.count || 0;
  
              const products = (data.products || [])
                .filter((p: any) => p.product_name)
                .map((p: any) => ({
                  barcode: p.code || null,
                  name: p.product_name || "Unknown Product",
                  brand: p.brands || "Unknown Brand",
                  image: p.image_url || "",
                  ingredients: parseIngredients(p.ingredients_text),
                  packaging: parsePackaging(p.packaging_text_en),
                  allergens: parseAllergens(p.allergens_tags),
                  category: mapCategory(p.categories_tags_en, db.name),
                  source: db.name,
                }));
  
              allProducts.push(...products);
            }
          } catch (err) {
            console.error(`Retry error from ${db.name}:`, err);
          }
        }
      }

    return NextResponse.json({
      query,
      count: totalCount,
      page: parseInt(page),
      pageSize: parseInt(pageSize),
      products: allProducts,
    });
  } catch (error) {
    console.error("Error searching products:", error);
    return NextResponse.json(
      { error: "Failed to search products" },
      { status: 500 }
    );
  }
}

async function searchUSDA(query: string): Promise<any[]> {
  if (!USDA_API_KEY) return [];

  try {
    const url = new URL("https://api.nal.usda.gov/fdc/v1/foods/search");
    url.searchParams.set("query", query);
    url.searchParams.set("api_key", USDA_API_KEY);
    url.searchParams.set("pageSize", "20");
    url.searchParams.set("dataType", "Branded");

    const response = await fetch(url.toString());
    if (!response.ok) return [];

    const data = await response.json();
    return (data.foods || [])
      .filter((f: any) => f.ingredients)
      .map((f: any) => ({
        barcode: f.gtinUpc || null,
        name: f.description || "Unknown Product",
        brand: f.brandOwner || f.brandName || "Unknown Brand",
        image: "",
        ingredients: parseIngredients(f.ingredients),
        packaging: [],
        allergens: [],
        category: "food",
        source: "usda",
      }));
  } catch (err) {
    console.error("Error fetching from USDA:", err);
    return [];
  }
}

// POST /api/product-search
// Look up a single product by barcode — searches all databases
// Body: { barcode: "3017620422003" }
export async function POST(request: Request) {
  try {
    const { barcode } = await request.json();

    if (!barcode) {
      return NextResponse.json(
        { error: "barcode is required" },
        { status: 400 }
      );
    }

    // Try each database until we find the product
    for (const [name, baseUrl] of Object.entries(DATABASES)) {
      try {
        const url = `${baseUrl}/api/v2/product/${barcode}.json?fields=code,product_name,brands,ingredients_text,image_url,packaging_text_en,categories_tags_en,allergens_tags`;

        const response = await fetch(url, {
          headers: { "User-Agent": "Enaj/1.0 (https://enaj.app)" },
        });

        if (response.ok) {
            const data = await response.json();
            if (data.product && data.product.product_name) {
              const p = data.product;
              return NextResponse.json({
                product: {
                  barcode: p.code || barcode,
                  name: p.product_name,
                  brand: p.brands || "Unknown Brand",
                  image: p.image_url || "",
                  ingredients: parseIngredients(p.ingredients_text),
                  packaging: parsePackaging(p.packaging_text_en),
                  allergens: parseAllergens(p.allergens_tags),
                  category: mapCategory(p.categories_tags_en, name),
                  source: name,
                },
              });
            }
          }
        } catch (err) {
          continue;
        }
      }
  
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    } catch (error) {
      console.error("Error fetching product by barcode:", error);
      return NextResponse.json(
        { error: "Failed to fetch product" },
        { status: 500 }
      );
    }
  }

  function parseIngredients(text: string | undefined): string[] {
    if (!text) return [];
    
    let cleaned = text;
    
    // Remove all parentheses but keep content — handle nested ones
    // Keep replacing until no parentheses remain
    while (cleaned.includes("(") || cleaned.includes(")")) {
      cleaned = cleaned.replace(/\s*\(/g, ", ");
      cleaned = cleaned.replace(/\)/g, "");
    }
    
    // Remove percentage info like "55%" or "< 2%"
    cleaned = cleaned.replace(/<?\s*\d+(\.\d+)?\s*%/g, "");
    
    // Remove brackets and keep content
    while (cleaned.includes("[") || cleaned.includes("]")) {
      cleaned = cleaned.replace(/\s*\[/g, ", ");
      cleaned = cleaned.replace(/\]/g, "");
    }
    
    // Split on commas
    return cleaned
      .split(",")
      .map((s) => s.replace(/^\s*[-–—:]\s*/, "").trim())
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter((s) => s.length > 1)
      .filter((s) => !s.match(/^\d+$/))
      .filter((value, index, self) => self.indexOf(value) === index);
  }

function parsePackaging(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function mapCategory(
    categories: string[] | undefined,
    source: string
  ): string {
    if (source === "beauty") {
      const joined = (categories || []).join(" ").toLowerCase();
      if (joined.includes("hair") || joined.includes("shampoo") || joined.includes("conditioner")) return "haircare";
      if (joined.includes("makeup") || joined.includes("mascara") || joined.includes("foundation") || joined.includes("lipstick") || joined.includes("eyeshadow")) return "makeup";
      if (joined.includes("fragrance") || joined.includes("perfume") || joined.includes("cologne") || joined.includes("eau de")) return "fragrance";
      if (joined.includes("body") || joined.includes("skin") || joined.includes("cream") || joined.includes("lotion") || joined.includes("sunscreen") || joined.includes("moistur") || joined.includes("soap") || joined.includes("face")) return "skin-body";
      return "skin-body";
    }
  
    const joined = (categories || []).join(" ").toLowerCase();
    
    // Cleaning & household detection
    if (joined.includes("cleaning") || joined.includes("detergent") || joined.includes("laundry") || joined.includes("dish") || joined.includes("bleach") || joined.includes("disinfect") || joined.includes("cleaner")) return "cleaning";
    if (joined.includes("household") || joined.includes("candle") || joined.includes("air freshener") || joined.includes("fabric softener") || joined.includes("trash bag")) return "household";
    
    // Personal care that comes through food database
    if (joined.includes("shampoo") || joined.includes("conditioner") || joined.includes("hair")) return "haircare";
    if (joined.includes("toothpaste") || joined.includes("deodorant") || joined.includes("soap") || joined.includes("body wash") || joined.includes("lotion") || joined.includes("skin") || joined.includes("sunscreen")) return "skin-body";
    if (joined.includes("perfume") || joined.includes("fragrance") || joined.includes("cologne")) return "fragrance";
    if (joined.includes("makeup") || joined.includes("cosmetic") || joined.includes("lipstick") || joined.includes("mascara")) return "makeup";
  
    return "food";
  }

function parseAllergens(tags: string[] | undefined): string[] {
    if (!tags) return [];
    // Open Food Facts returns allergens like "en:gluten", "en:milk", "en:soybeans"
    return tags.map((t) => {
      const name = t.replace(/^[a-z]{2}:/, ""); // remove language prefix
      return name.charAt(0).toUpperCase() + name.slice(1); // capitalize
    });
  }