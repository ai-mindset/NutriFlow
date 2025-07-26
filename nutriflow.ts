#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write

/**
 * NutriFlow - Functional Plant-Based Meal Planner
 * Simple, robust, privacy-first TUI for body recomposition nutrition
 */

import { Confirm, Input, Select } from "@cliffy/prompt/mod.ts";
import { Table } from "@cliffy/table/mod.ts";
import { colors } from "@cliffy/ansi/colors.ts";

// =============================================================================
// TYPES & CONSTANTS
// =============================================================================

type ActivityLevel = "sedentary" | "low" | "moderate" | "high";
type Goal = "recomp" | "maintain" | "gain";
type MealType = "breakfast" | "lunch" | "dinner" | "snack";

interface Profile {
  readonly age: number;
  readonly weight: number;
  readonly height: number;
  readonly activityLevel: ActivityLevel;
  readonly goal: Goal;
}

interface Targets {
  readonly calories: number;
  readonly protein: number;
  readonly carbs: number;
  readonly fat: number;
  readonly fiber: number;
}

interface Food {
  readonly name: string;
  readonly protein: number;
  readonly carbs: number;
  readonly fat: number;
  readonly fiber: number;
  readonly calories: number;
}

interface Meal {
  readonly name: string;
  readonly type: MealType;
  readonly foods: ReadonlyArray<{ food: Food; grams: number }>;
  readonly prepTime: number;
  readonly instructions: ReadonlyArray<string>;
}

interface CircuitState {
  failures: number;
  lastFailure: number;
}

interface OllamaResponse {
  response: string;
  done: boolean;
  model?: string;
  created_at?: string;
}

interface OpenFoodFactsProduct {
  product_name?: string;
  nutriments?: {
    "energy-kcal_100g"?: number;
    energy_kcal_100g?: number;
    proteins_100g?: number;
    carbohydrates_100g?: number;
    fat_100g?: number;
    fiber_100g?: number;
  };
  nova_group?: number;
}

interface OpenFoodFactsResponse {
  products?: OpenFoodFactsProduct[];
}

interface MealPlanJSON {
  meals: Array<{
    name: string;
    type: string;
    foods: Array<{ name: string; grams: number }>;
    prepTime: number;
    cookingMethod?: string;
    instructions: string[];
  }>;
}

const CONFIG = {
  OLLAMA_URL: "http://localhost:11434",
  OLLAMA_MODEL: "gemma3n:latest",
  MEAL_GENERATION_TIMEOUT_MS: 300000, // 300 seconds for meal generation
  TIMEOUT_MS: 8000,
  MAX_RETRIES: 2,
  CACHE_SIZE: 50,
} as const;

const OFF_API_BASE = "https://world.openfoodfacts.org/api/v2";

// =============================================================================
// VALIDATION FUNCTIONS
// =============================================================================

const isValidAgeYr = (age: number): boolean => Number.isInteger(age) && age >= 18 && age <= 100;

const isValidWeightKg = (weight: number): boolean =>
  Number.isFinite(weight) && weight >= 30 && weight <= 300;

const isValidHeightCm = (height: number): boolean =>
  Number.isFinite(height) && height >= 120 && height <= 250;

const isValidPrepTimeMin = (minutes: number): boolean =>
  Number.isInteger(minutes) && minutes >= 5 && minutes <= 120;

const sanitizeInput = (input: string): string => input.trim().slice(0, 200).replace(/[<>]/g, "");

// =============================================================================
// LOGGING FUNCTIONS
// =============================================================================

const log = {
  info: (msg: string) => console.log(colors.blue("ℹ"), msg),
  success: (msg: string) => console.log(colors.green("✓"), msg),
  error: (msg: string) => console.log(colors.red("✗"), msg),
  warn: (msg: string) => console.log(colors.yellow("⚠"), msg),
};

// =============================================================================
// NUTRITION CALCULATIONS
// =============================================================================

const calculateTargets = (profile: Profile): Targets => {
  // Mifflin-St Jeor with perimenopause adjustments https://en.wikipedia.org/wiki/Basal_metabolic_rate
  const sWomen = 161; // +5 for men, per Wikipedia article
  const bmr = (10 * profile.weight) + (6.25 * profile.height) -
    (5 * profile.age) - sWomen;
  // Activity multiplier https://learn.athleanx.com/calculators/bmr-calculator
  const multiplier = profile.activityLevel === "sedentary"
    ? 1.2
    : profile.activityLevel === "low"
    ? 1.375
    : profile.activityLevel === "moderate"
    ? 1.55
    : profile.activityLevel === "high"
    ? 1.725
    : 1.55;
  const tdee = bmr * multiplier;

  // 5% deficit for recomposition, maintenance otherwise
  const calories = Math.round(profile.goal === "recomp" ? tdee * 0.95 : tdee);

  // Evidence-based macros for perimenopausal women
  const protein = Math.round(profile.weight * 1.8); // 1.8g/kg for muscle preservation
  const carbs = Math.round(profile.weight * 2.5); // 2.5g/kg for training fuel
  const fat = Math.round((calories - (protein * 4) - (carbs * 4)) / 9);
  const fiber = Math.max(35, Math.round(calories / 50)); // High fiber for hormonal balance

  return { calories, protein, carbs, fat, fiber };
};

// =============================================================================
// OPEN FOOD FACTS API & FOOD DATABASE
// =============================================================================

// Minimal high-protein plant foods for offline fallback
const FALLBACK_FOODS: ReadonlyArray<Food> = [
  {
    name: "Tofu, firm",
    protein: 15.7,
    carbs: 4.3,
    fat: 8.7,
    fiber: 2.3,
    calories: 144,
  },
  {
    name: "Tempeh",
    protein: 21.3,
    carbs: 1.8,
    fat: 10.9,
    fiber: 6.1,
    calories: 208,
  },
  {
    name: "Green lentils in water",
    protein: 6,
    carbs: 12,
    fat: 0.5,
    fiber: 4.1,
    calories: 82,
  },
  {
    name: "Chickpeas in water",
    protein: 7.2,
    carbs: 23.4,
    fat: 2.2,
    fiber: 7.4,
    calories: 127,
  },
  {
    name: "Shelled Hemp",
    protein: 35,
    carbs: 1.1,
    fat: 52,
    fiber: 4.5,
    calories: 617,
  },
  {
    name: "Nutritional yeast",
    protein: 50.6,
    carbs: 10,
    fat: 4.8,
    fiber: 23.2,
    calories: 332,
  },
] as const;

// Cache for API responses
const foodCache = new Map<string, ReadonlyArray<Food>>();

const parseOpenFoodFactsProduct = (
  product: OpenFoodFactsProduct,
): Food | null => {
  if (!product?.nutriments) return null;

  const n = product.nutriments;
  const name = product.product_name?.trim();

  if (!name) return null;

  // Ensure we have basic nutrition data
  const calories = n["energy-kcal_100g"] || n.energy_kcal_100g || 0;
  const protein = n.proteins_100g || 0;
  const carbs = n.carbohydrates_100g || 0;
  const fat = n.fat_100g || 0;
  const fiber = n.fiber_100g || 0;

  if (calories === 0 && protein === 0) return null;

  return {
    name: sanitizeInput(name),
    protein: Math.max(0, protein),
    carbs: Math.max(0, carbs),
    fat: Math.max(0, fat),
    fiber: Math.max(0, fiber),
    calories: Math.max(0, calories),
  };
};

const searchOpenFoodFacts = async (
  query: string,
): Promise<ReadonlyArray<Food>> => {
  const cacheKey = query.toLowerCase().trim();

  if (foodCache.has(cacheKey)) {
    return foodCache.get(cacheKey)!;
  }

  try {
    const searchUrl = new URL(`${OFF_API_BASE}/search`);
    searchUrl.searchParams.set("categories_tags_en", query);
    searchUrl.searchParams.set("fields", "product_name,nutriments");
    searchUrl.searchParams.set("page_size", "20");

    const response = await withTimeout(
      fetch(searchUrl.toString()),
      CONFIG.TIMEOUT_MS,
    );

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data: OpenFoodFactsResponse = await response.json();
    const products = data.products || [];

    const foods = products
      .map(parseOpenFoodFactsProduct)
      .filter((food: Food | null): food is Food =>
        food !== null &&
        food.calories > 0 &&
        (food.protein >= 3 || food.fiber >= 3) // Basic nutrition filter
      )
      .slice(0, 15);

    if (foodCache.size >= CONFIG.CACHE_SIZE) {
      const firstKey = foodCache.keys().next().value;
      foodCache.delete(firstKey);
    }
    foodCache.set(cacheKey, foods);

    return foods;
  } catch (error) {
    return searchFallbackFoods(query);
  }
};

const searchFallbackFoods = (query: string): ReadonlyArray<Food> => {
  const term = query.toLowerCase().trim();
  return FALLBACK_FOODS.filter((food) => food.name.toLowerCase().includes(term));
};

const searchFoods = async (query: string): Promise<ReadonlyArray<Food>> => {
  const apiResults = await searchOpenFoodFacts(query);

  if (apiResults.length > 0) {
    return apiResults;
  }

  // Fallback to local foods if API returns nothing
  return searchFallbackFoods(query);
};

const getHighProteinFoods = async (): Promise<ReadonlyArray<Food>> => {
  const highProteinQueries = [
    "tofu",
    "tempeh",
    "seitan",
    "hemp seeds",
    "nutritional yeast",
  ];
  const allFoods: Food[] = [];

  for (const query of highProteinQueries) {
    const foods = await searchOpenFoodFacts(query);
    allFoods.push(...foods);
  }

  return allFoods
    .filter((food) => food.protein >= 15)
    .sort((a, b) => b.protein - a.protein)
    .slice(0, 10);
};

const findOrCreateFood = async (name: string): Promise<Food> => {
  const sanitizedName = sanitizeInput(name);
  const found = await searchFoods(sanitizedName);

  return found[0] || {
    name: sanitizedName,
    protein: 8, // Higher baseline for plant proteins
    carbs: 15,
    fat: 3,
    fiber: 5, // Emphasis on fiber
    calories: 120,
  };
};

// =============================================================================
// CIRCUIT BREAKER STATE
// =============================================================================

let circuitState: CircuitState = { failures: 0, lastFailure: 0 };

const isCircuitOpen = (): boolean => {
  const threshold = 3;
  const timeout = 30000; // 30s
  return circuitState.failures >= threshold &&
    (Date.now() - circuitState.lastFailure) < timeout;
};

const recordSuccess = (): void => {
  circuitState.failures = 0;
};

const recordFailure = (): void => {
  circuitState.failures++;
  circuitState.lastFailure = Date.now();
};

// =============================================================================
// NETWORK FUNCTIONS
// =============================================================================

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error("Timeout")),
        );
      }),
    ]);
    clearTimeout(timeoutId);
    return result;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
};

const checkOllamaHealth = async (): Promise<boolean> => {
  try {
    const response = await withTimeout(
      fetch(`${CONFIG.OLLAMA_URL}/api/tags`),
      3000,
    );
    return response.ok;
  } catch {
    return false;
  }
};

// =============================================================================
// MEAL GENERATION
// =============================================================================

const buildPrompt = (targets: Targets, prefs: string[], maxTime: number): string =>
  `You are a professional plant-based nutritionist specializing in body recomposition for perimenopausal women. Create ONE daily meal plan.

EXACT NUTRITIONAL TARGETS (must be met):
- Total daily calories: ${targets.calories} kcal
- Total daily protein: ${targets.protein}g
- Total daily carbs: ${targets.carbs}g
- Total daily fat: ${targets.fat}g
- Total daily fiber: ${targets.fiber}g

MANDATORY MEAL REQUIREMENTS:
- Generate exactly 3 meals: 1 breakfast, 1 lunch, 1 dinner
- Each meal must contain minimum 20g protein AND 12g fiber
- Only whole, unprocessed plant foods (no meat substitutes, protein powders, or packaged foods)
- Each meal uses ONE cooking method only: raw preparation, one pot, one pan, or one baking tray
- Maximum preparation time per meal: ${maxTime} minutes
- User preferences to include: ${prefs.join(", ")}

REQUIRED FOODS TO EMPHASIZE:
- High-protein: tempeh, tofu, lentils, chickpeas, hemp seeds, nutritional yeast
- Complete proteins: combine legumes + grains OR nuts + seeds
- Anti-inflammatory: leafy greens, berries, nuts, olive oil, turmeric
- Hormone-supporting: flax seeds, soy foods, cruciferous vegetables

COOKING CONSTRAINTS:
- Breakfast: Raw or one-pan maximum
- Lunch: One-pot or one-tray maximum
- Dinner: One-pot, one-pan, or one-tray maximum
- Simple techniques only: sauté, steam, roast, boil, or raw

OUTPUT FORMAT (respond with ONLY this JSON, no other text):
{
 "meals": [
   {
     "name": "High-Protein [Food] [Cooking Method]",
     "type": "breakfast",
     "foods": [
       {"name": "firm tofu", "grams": 200},
       {"name": "hemp seeds", "grams": 30}
     ],
     "prepTime": ${Math.min(maxTime, 20)},
     "instructions": [
       "Heat 1 tbsp olive oil in large pan",
       "Crumble tofu, sauté 5 minutes until golden",
       "Add vegetables, cook 3 minutes",
       "Sprinkle hemp seeds before serving"
     ]
   }
 ]
}

Generate 3 complete meals that total exactly ${targets.calories} calories and ${targets.protein}g protein.`;

const parseMeals = (response: string): Promise<ReadonlyArray<Meal> | null> => {
  try {
    // Handle NDJSON response - get the last complete JSON object
    const lines = response.trim().split("\n").filter((line) => line.trim());
    const lastLine = lines[lines.length - 1];

    if (!lastLine) return Promise.resolve(null);

    const data: OllamaResponse = JSON.parse(lastLine);
    let aiResponse = data.response || "";

    // Clean up HTML entities and escape sequences
    aiResponse = aiResponse
      .replace(/\\u0026/g, '&')
      .replace(/\\u003c/g, '<')
      .replace(/\\u003e/g, '>')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');

    // Extract JSON from markdown code blocks if present
    const codeBlockMatch = aiResponse.match(/```json\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
      aiResponse = codeBlockMatch[1];
    }

    // Extract JSON object
    const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log("DEBUG: No JSON found in response:", aiResponse.slice(0, 200));
      return Promise.resolve(null);
    }

    const mealData: MealPlanJSON = JSON.parse(jsonMatch[0]);
    if (!mealData.meals || !Array.isArray(mealData.meals)) {
      return Promise.resolve(null);
    }

    return Promise.all(mealData.meals.map(async (meal): Promise<Meal> => {
      const foods = await Promise.all((meal.foods || []).map(async (f) => ({
        food: await findOrCreateFood(f.name),
        grams: Math.max(1, Math.min(1000, Number(f.grams) || 100)),
      })));

      const validTypes: MealType[] = ["breakfast", "lunch", "dinner", "snack"];

      return {
        name: sanitizeInput(meal.name || "Unnamed Meal"),
        type: validTypes.includes(meal.type as MealType) ? meal.type as MealType : "snack",
        foods,
        prepTime: Math.max(5, Math.min(120, Number(meal.prepTime) || 20)),
        instructions: (meal.instructions || [])
          .map((s: string) => sanitizeInput(s))
          .slice(0, 6),
      };
    })).then((meals) => meals.slice(0, 6));
  } catch (error) {
    console.log("DEBUG: Parse error:", (error as Error).message);
    console.log("DEBUG: Full response length:", response.length);
    console.log("DEBUG: Full response:", response);
    return Promise.resolve(null);
  }
};
const generateFallbackMeals = async (
  maxTime: number,
): Promise<ReadonlyArray<Meal>> => {
  const highProtein = await getHighProteinFoods();

  return [
    {
      name: "High-Protein Tofu Scramble Bowl",
      type: "breakfast" as const,
      foods: [
        { food: highProtein[0] || FALLBACK_FOODS[0], grams: 200 },
        { food: await findOrCreateFood("spinach"), grams: 100 },
        { food: await findOrCreateFood("hemp seeds"), grams: 15 },
        { food: await findOrCreateFood("nutritional yeast"), grams: 10 },
      ],
      prepTime: Math.min(maxTime, 15),
      instructions: [
        "Heat pan with oil",
        "Crumble tofu and sauté 5 min",
        "Add spinach until wilted",
        "Top with hemp seeds and nutritional yeast",
      ],
    },
    {
      name: "Power Lentil & Quinoa One-Pot",
      type: "lunch" as const,
      foods: [
        { food: await findOrCreateFood("red lentils"), grams: 150 },
        { food: await findOrCreateFood("quinoa"), grams: 100 },
        { food: await findOrCreateFood("kale"), grams: 80 },
        { food: await findOrCreateFood("tahini"), grams: 20 },
      ],
      prepTime: Math.min(maxTime, 25),
      instructions: [
        "Combine lentils, quinoa, and 3 cups water in pot",
        "Simmer 20 min until tender",
        "Stir in chopped kale last 2 min",
        "Serve with tahini drizzle",
      ],
    },
    {
      name: "Tempeh & Vegetable Sheet Pan",
      type: "dinner" as const,
      foods: [
        { food: highProtein[1] || FALLBACK_FOODS[1], grams: 150 },
        { food: await findOrCreateFood("sweet potato"), grams: 200 },
        { food: await findOrCreateFood("broccoli"), grams: 150 },
        { food: await findOrCreateFood("pumpkin seeds"), grams: 20 },
      ],
      prepTime: Math.min(maxTime, 30),
      instructions: [
        "Cube tempeh and vegetables",
        "Toss with oil and seasonings on tray",
        "Roast at 200°C for 25 min",
        "Sprinkle with pumpkin seeds before serving",
      ],
    },
  ];
};

// Simple cache using Map
const mealCache = new Map<string, ReadonlyArray<Meal>>();

const generateMealPlan = async (
  targets: Targets,
  preferences: string[],
  maxPrepTime: number,
): Promise<ReadonlyArray<Meal> | null> => {
  const cacheKey = `${JSON.stringify(targets)}_${preferences.join(",")}_${maxPrepTime}`;

  // Check cache first
  if (mealCache.has(cacheKey)) {
    return mealCache.get(cacheKey)!;
  }

  // Check circuit breaker
  if (isCircuitOpen()) {
    log.warn("Service temporarily unavailable, using fallback meals");
    return await generateFallbackMeals(maxPrepTime);
  }

  try {
    const prompt = buildPrompt(targets, preferences, maxPrepTime);

    // console.log("DEBUG: Ollama URL:", CONFIG.OLLAMA_URL);
    console.log("DEBUG: Ollama model:", CONFIG.OLLAMA_MODEL);

    const response = await withTimeout(
      fetch(`${CONFIG.OLLAMA_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: CONFIG.OLLAMA_MODEL,
          prompt,
          stream: false,
          options: { temperature: 0.7, top_p: 0.9 },
        }),
      }),
      CONFIG.MEAL_GENERATION_TIMEOUT_MS, // Use longer timeout here
    );

    console.log("DEBUG: Response status:", response.status);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const responseText = await response.text();
    // console.log("DEBUG: Raw response:", responseText.slice(0, 300));

    recordSuccess();

    const meals = await parseMeals(responseText);
    if (!meals || meals.length === 0) {
      return await generateFallbackMeals(maxPrepTime);
    }

    // Cache successful responses (with size limit)
    if (mealCache.size >= CONFIG.CACHE_SIZE) {
      const firstKey = mealCache.keys().next().value;
      mealCache.delete(firstKey);
    }
    mealCache.set(cacheKey, meals);

    return meals;
  } catch (error) {
    recordFailure();
    log.error(`AI generation failed: ${(error as Error).message}`);
    return await generateFallbackMeals(maxPrepTime);
  }
};

// =============================================================================
// USER INTERFACE FUNCTIONS
// =============================================================================

const showWelcome = (): void => {
  console.clear();
  console.log(colors.green.bold(`
    ╔═══════════════════════════════════════╗
    ║           🌱 NutriFlow 🌱             ║
    ║   Functional Plant-Based Nutrition    ║
    ╚═══════════════════════════════════════╝
    `));
};

const showMenu = async (): Promise<string> => {
  return await Select.prompt({
    message: "Choose an action:",
    options: [
      { name: "Set up profile", value: "setup" },
      { name: "Generate meal plan", value: "generate" },
      { name: "Search foods", value: "search" },
      { name: "View targets", value: "targets" },
      { name: "Exit", value: "exit" },
    ],
  });
};

const getValidatedInput = async (
  message: string,
  validator: (val: string) => boolean,
  errorMsg: string,
): Promise<string> => {
  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    const input = await Input.prompt(message);
    if (validator(input)) {
      return input;
    }

    attempts++;
    log.error(`${errorMsg} (${maxAttempts - attempts} attempts remaining)`);
  }

  throw new Error("Too many invalid inputs. Please restart setup.");
};

const setupProfile = async (): Promise<Profile> => {
  log.info("Setting up your nutrition profile...\n");

  const age = await getValidatedInput(
    "Age (18-100):",
    (val) => isValidAgeYr(parseInt(val)),
    "Please enter a valid age between 18 and 100",
  );

  const weight = await getValidatedInput(
    "Weight in kg (30-300):",
    (val) => isValidWeightKg(parseFloat(val)),
    "Please enter a valid weight between 30-300 kg",
  );

  const height = await getValidatedInput(
    "Height in cm (120-250):",
    (val) => isValidHeightCm(parseFloat(val)),
    "Please enter a valid height between 120-250 cm",
  );

  const activityLevel = await Select.prompt({
    message: "Activity level:",
    options: [
      { name: "Sedentary (little or no exercise)", value: "sedentary" },
      { name: "Low (light exercise 1-3 days/week)", value: "low" },
      { name: "Moderate (moderate exercise 3-5 days/week)", value: "moderate" },
      { name: "High (hard exercise 6-7 days/week)", value: "high" },
    ],
  }) as ActivityLevel;

  const goal = await Select.prompt({
    message: "Primary goal:",
    options: [
      { name: "Body recomposition (lose fat, gain muscle)", value: "recomp" },
      { name: "Maintain current composition", value: "maintain" },
      { name: "Gain muscle", value: "gain" },
    ],
  }) as Goal;

  return {
    age: parseInt(age),
    weight: parseFloat(weight),
    height: parseFloat(height),
    activityLevel,
    goal,
  };
};

const showTargets = (targets: Targets): void => {
  console.log("\n" + colors.bold("Your Daily Nutrition Targets:"));
  const table = new Table()
    .header(["Nutrient", "Target", "Purpose"])
    .body([
      [
        "Calories",
        `${targets.calories} kcal`,
        "Energy balance for recomposition",
      ],
      ["Protein", `${targets.protein}g`, "Muscle preservation & growth"],
      ["Carbohydrates", `${targets.carbs}g`, "Training fuel & recovery"],
      ["Fat", `${targets.fat}g`, "Hormone production & health"],
      ["Fiber", `${targets.fiber}g`, "Gut health & satiety"],
    ]);
  table.render();
};

const calculateMealTotals = (meal: Meal) => {
  return meal.foods.reduce((totals, { food, grams }) => {
    const factor = grams / 100;
    return {
      calories: totals.calories + food.calories * factor,
      protein: totals.protein + food.protein * factor,
      carbs: totals.carbs + food.carbs * factor,
      fat: totals.fat + food.fat * factor,
      fiber: totals.fiber + food.fiber * factor,
    };
  }, { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 });
};

const displayMeals = (meals: ReadonlyArray<Meal>, targets?: Targets): void => {
  console.log("\n" + colors.bold.green("🍽️ Your Meal Plan"));
  console.log("═".repeat(50));

  let dailyTotals = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };

  for (const meal of meals) {
    console.log(`\n${colors.bold.yellow(meal.name)} (${meal.type})`);
    console.log(`⏱️ ${meal.prepTime} minutes`);

    const mealTotals = calculateMealTotals(meal);

    // Add to daily totals
    dailyTotals.calories += mealTotals.calories;
    dailyTotals.protein += mealTotals.protein;
    dailyTotals.carbs += mealTotals.carbs;
    dailyTotals.fat += mealTotals.fat;
    dailyTotals.fiber += mealTotals.fiber;

    console.log("\nIngredients:");
    for (const { food, grams } of meal.foods) {
      console.log(`  • ${grams}g ${food.name}`);
    }

    console.log(
      `📊 ${Math.round(mealTotals.calories)}kcal | P:${Math.round(mealTotals.protein)}g | C:${
        Math.round(mealTotals.carbs)
      }g | F:${Math.round(mealTotals.fat)}g | Fiber:${Math.round(mealTotals.fiber)}g`,
    );

    if (meal.instructions.length > 0) {
      console.log("\nSteps:");
      meal.instructions.forEach((step, i) => {
        console.log(`  ${i + 1}. ${step}`);
      });
    }

    console.log("─".repeat(40));
  }

  // Show daily totals vs targets
  if (targets) {
    console.log("\n" + colors.bold("Daily Totals vs Targets:"));
    const table = new Table()
      .header(["Nutrient", "Actual", "Target", "Difference"])
      .body([
        [
          "Calories",
          `${Math.round(dailyTotals.calories)}`,
          `${targets.calories}`,
          `${Math.round(dailyTotals.calories - targets.calories)}`,
        ],
        [
          "Protein (g)",
          `${Math.round(dailyTotals.protein)}`,
          `${targets.protein}`,
          `${Math.round(dailyTotals.protein - targets.protein)}`,
        ],
        [
          "Carbs (g)",
          `${Math.round(dailyTotals.carbs)}`,
          `${targets.carbs}`,
          `${Math.round(dailyTotals.carbs - targets.carbs)}`,
        ],
        [
          "Fat (g)",
          `${Math.round(dailyTotals.fat)}`,
          `${targets.fat}`,
          `${Math.round(dailyTotals.fat - targets.fat)}`,
        ],
        [
          "Fiber (g)",
          `${Math.round(dailyTotals.fiber)}`,
          `${targets.fiber}`,
          `${Math.round(dailyTotals.fiber - targets.fiber)}`,
        ],
      ]);
    table.render();
  }
};

const saveMeals = async (
  meals: ReadonlyArray<Meal>,
  profile: Profile,
  targets: Targets,
): Promise<void> => {
  try {
    const data = {
      date: new Date().toISOString().split("T")[0],
      profile,
      targets,
      meals,
    };

    await Deno.mkdir("./meal_plans", { recursive: true });
    const filename = `./meal_plans/plan_${data.date}.json`;
    await Deno.writeTextFile(filename, JSON.stringify(data, null, 2));
    log.success(`Saved to ${filename}`);
  } catch (error) {
    log.error(`Save failed: ${(error as Error).message}`);
  }
};

const searchAndDisplayFoods = async (): Promise<void> => {
  const query = await Input.prompt("Search foods:");
  const results = await searchFoods(query);

  if (results.length === 0) {
    log.warn("No foods found. Try a different term.");
    return;
  }

  console.log(`\n${colors.bold("Search Results:")} (${results.length} found)`);

  const table = new Table()
    .header([
      "Food",
      "Protein/100g",
      "Carbs/100g",
      "Fat/100g",
      "Fiber/100g",
      "Calories/100g",
    ])
    .body(results.map((food) => [
      food.name.length > 25 ? food.name.slice(0, 25) + "..." : food.name,
      `${food.protein}g`,
      `${food.carbs}g`,
      `${food.fat}g`,
      `${food.fiber}g`,
      `${food.calories}`,
    ]));

  table.render();
};

// =============================================================================
// MAIN APPLICATION LOOP
// =============================================================================

const main = async (): Promise<void> => {
  showWelcome();

  // Health check
  const ollamaAvailable = await checkOllamaHealth();
  if (!ollamaAvailable) {
    log.warn(
      "Ollama not available. Using offline mode with local meal templates.",
    );
  }

  let profile: Profile | null = null;
  let targets: Targets | null = null;

  while (true) {
    const action = await showMenu();

    try {
      switch (action) {
        case "setup":
          profile = await setupProfile();
          targets = calculateTargets(profile);
          log.success("Profile saved successfully!");
          showTargets(targets);
          await Input.prompt("\nPress Enter to continue...");
          break;

        case "generate":
          if (!profile || !targets) {
            log.warn("Please set up your profile first.");
            break;
          }

          const maxTime = await getValidatedInput(
            "Max prep time per meal (5-120 minutes):",
            (val) => isValidPrepTimeMin(parseInt(val)),
            "Please enter a valid time between 5-120 minutes",
          );

          const prefs = await Input.prompt({
            message: "Food preferences (comma-separated):",
            default: "tofu, tempeh, lentils, quinoa",
          });

          log.info("Generating your meal plan...");

          const preferences = prefs.split(",").map((p) => sanitizeInput(p))
            .filter(Boolean);
          const meals = await generateMealPlan(
            targets,
            preferences,
            parseInt(maxTime),
          );

          if (!meals || meals.length === 0) {
            log.error("Failed to generate meals. Please try again.");
            break;
          }

          displayMeals(meals, targets);

          const save = await Confirm.prompt("Save this meal plan?");
          if (save) {
            await saveMeals(meals, profile, targets);
          }

          await Input.prompt("\nPress Enter to continue...");
          break;

        case "search":
          await searchAndDisplayFoods();
          await Input.prompt("\nPress Enter to continue...");
          break;

        case "targets":
          if (!targets) {
            log.warn("Please set up your profile first.");
          } else {
            showTargets(targets);
          }
          await Input.prompt("\nPress Enter to continue...");
          break;

        case "exit":
          log.success("Thank you for using NutriFlow! 🌱");
          Deno.exit(0);
      }
    } catch (error) {
      log.error(`Operation failed: ${(error as Error).message}`);
      await Input.prompt("Press Enter to continue...");
    }
  }
};

// =============================================================================
// ENTRY POINT
// =============================================================================

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    log.error(`Application error: ${(error as Error).message}`);
    console.log("\nIf this persists, please check:");
    console.log("1. Deno is properly installed");
    console.log("2. Internet connection is available");
    console.log("3. Ollama is running (optional)");
    Deno.exit(1);
  }
}
