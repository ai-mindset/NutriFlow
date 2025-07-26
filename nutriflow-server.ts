// advanced-nutrition-server.ts
import { McpServer } from "npm:@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "npm:@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "https://deno.land/x/zod/mod.ts";

interface OpenFoodFactsProduct {
  product_name?: string;
  brands?: string;
  nutrition_grades?: string;
  nutriments?: {
    'energy-kcal_100g'?: number;
    proteins_100g?: number;
    carbohydrates_100g?: number;
    fat_100g?: number;
    fiber_100g?: number;
  };
  code?: string;
}

interface OpenFoodFactsResponse {
  products?: OpenFoodFactsProduct[];
  count?: number;
  page_size?: number;
}

interface NutritionData {
  name: string;
  calories_per_100g: number;
  protein_per_100g: number;
  carbs_per_100g: number;
  fat_per_100g: number;
  fiber_per_100g: number;
}

const server = new McpServer({
  name: "meal-planning-server",
  version: "1.0.0"
});

// Single-source nutrition search (Open Food Facts only)
server.registerTool(
  "search_nutrition_data",
  {
    title: "Search Nutrition Data",
    description: "Search Open Food Facts database for plant-based nutrition information",
    inputSchema: {
      query: z.string(),
      max_results: z.number().default(20)
    }
  },
 async ({ query, max_results = 20 }: { query: string; max_results?: number }) => {
    const results = await searchOpenFoodFacts(query, max_results);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ products: results, count: results.length }, null, 2)
      }]
    };
  }
);

// Meal plan generation with nutritional analysis
server.registerTool(
 "generate_meal_plan",
 {
   title: "Generate Meal Plan",
   description: "Create personalized plant-based meal plan with nutritional analysis",
   inputSchema: {
     calorie_target: z.number(),
     days: z.number().default(7),
     preferred_foods: z.array(z.string()).optional()
   }
 },
 async ({ calorie_target, days, preferred_foods = [] }: {
   calorie_target: number;
   days: number;
   preferred_foods?: string[];
 }) => {
   const dailyCalorieTarget: number = calorie_target;
   const mealPlan: Array<{
     day: number;
     meals: Record<string, string[]>;
     total_calories: number;
   }> = [];

   for (let day = 1; day <= days; day++) {
     const dayMeals = await generateDayMeals({
       calorieTarget: dailyCalorieTarget,
       preferences: preferred_foods
     });

     mealPlan.push({
       day,
       meals: dayMeals,
       total_calories: dailyCalorieTarget
     });
   }

   return {
     content: [{
       type: "text",
       text: JSON.stringify({ meal_plan: mealPlan }, null, 2)
     }]
   };
 }
);

// Helper functions with proper types
async function searchOpenFoodFacts(query: string, limit: number): Promise<NutritionData[]> {
  const url = `https://world.openfoodfacts.org/api/v2/search`;
  const params = new URLSearchParams({
    search_terms: query,
    page_size: limit.toString(),
    categories_tags_en: 'plant-based-foods',
    fields: 'product_name,brands,nutrition_grades,nutriments,code'
  });

  try {
    const response = await fetch(`${url}?${params}`);
    const data: OpenFoodFactsResponse = await response.json();

    return (data.products || [])
      .filter((product): product is OpenFoodFactsProduct =>
        Boolean(product?.product_name && product?.nutriments)
      )
      .map((product): NutritionData => ({
        name: product.product_name!,
        calories_per_100g: product.nutriments?.['energy-kcal_100g'] || 0,
        protein_per_100g: product.nutriments?.proteins_100g || 0,
        carbs_per_100g: product.nutriments?.carbohydrates_100g || 0,
        fat_per_100g: product.nutriments?.fat_100g || 0,
        fiber_per_100g: product.nutriments?.fiber_100g || 0
      }))
      .filter(item => item.calories_per_100g > 0);
  } catch (error) {
    console.error('OpenFoodFacts API error:', error);
    return [];
  }
}

async function generateDayMeals(options: {
  calorieTarget: number;
  preferences: string[];
}): Promise<Record<string, string[]>> {
  // Simple meal generation using preferences
  const mealTypes = ['breakfast', 'lunch', 'dinner', 'snacks'];
  const meals: Record<string, string[]> = {};

  for (const mealType of mealTypes) {
    const searchTerm = options.preferences[0] || 'tofu';
    const foods = await searchOpenFoodFacts(searchTerm, 3);
    meals[mealType] = foods.map(food => food.name);
  }

  return meals;
}

if (import.meta.main) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
