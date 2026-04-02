#!/usr/bin/env node

/**
 * Homey Device Discovery Tool for MMM-HomeyIntegration
 * 
 * Use this tool to discover Homey devices, their IDs, and capabilities
 * so you can configure MMM-HomeyIntegration webhooks, MQTT, or API pollers.
 * 
 * Usage:
 *   node discover-homey-devices.js [filter] [capability-filter]
 * 
 * Examples:
 *   node discover-homey-devices.js                             # Show all devices
 *   node discover-homey-devices.js "temperature"               # Find by device name
 *   node discover-homey-devices.js "*temp*" "measure_*"        # Find by name + capability
 *   node discover-homey-devices.js --ip 192.168.10.35 --token YOUR_TOKEN "*"
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

// ============================================================================
// MANUAL CONFIGURATION
// ============================================================================
// IMPORTANT: This tool requires MMM-HomeyIntegration to be configured in config.js
// with at least the api.baseUrl and Authorization header.
//
// Example config.js:
// {
//   module: "MMM-HomeyIntegration",
//   config: {
//     api: {
//       enabled: true,
//       baseUrl: "http://192.168.10.35",
//       headers: {
//         Authorization: "Bearer YOUR_HOMEY_API_TOKEN"
//       }
//     }
//   }
// }

// ============================================================================
// AUTO-LOAD FROM CONFIG.JS
// ============================================================================
function cleanHostname(hostStr) {
  if (!hostStr) return null;
  // Remove http://, https://, trailing slashes
  return hostStr
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
    .trim();
}

function loadConfigFromMagicMirror() {
  try {
    const possiblePaths = [
      path.join(__dirname, '../../../config/config.js'),
      path.join(__dirname, '../../config/config.js'),
      path.join(process.cwd(), 'config/config.js'),
      path.join(process.env.HOME, 'MagicMirror/config/config.js')
    ];

    for (const configPath of possiblePaths) {
      if (fs.existsSync(configPath)) {
        const configContent = fs.readFileSync(configPath, 'utf8');
        
        let homeyIP = null;
        let homeyToken = null;
        let source = null;
        
        // PRIORITY 1: MMM-HomeyIntegration module config
        const moduleMatch = configContent.match(/module:\s*["']MMM-HomeyIntegration["']\s*,[\s\S]*?config:\s*{([\s\S]*?)(?=},\s*\{|}\s*\],)}/);
        if (moduleMatch) {
          const moduleConfig = moduleMatch[1];
          
          // Extract baseUrl from api config
          const baseUrlMatch = moduleConfig.match(/baseUrl:\s*["']([^"']+)["']/);
          if (baseUrlMatch) {
            homeyIP = cleanHostname(baseUrlMatch[1]);
            source = "MMM-HomeyIntegration api.baseUrl";
          }
          
          // Extract token from Authorization header
          const authMatch = moduleConfig.match(/Authorization:\s*["']Bearer\s+([^"']+)["']/);
          if (authMatch) {
            homeyToken = authMatch[1];
          }
        }
        
        // PRIORITY 2: Global homeyIP variable
        if (!homeyIP) {
          const ipVarMatches = configContent.match(/^const\s+homeyIP\s*=\s*["']([^"']+)["']/gm);
          if (ipVarMatches && ipVarMatches.length > 0) {
            const lastMatch = ipVarMatches[ipVarMatches.length - 1];
            const extracted = lastMatch.match(/["']([^"']+)["']/);
            if (extracted) {
              homeyIP = cleanHostname(extracted[1]);
              source = "global homeyIP variable";
            }
          }
        }
        
        // PRIORITY 3: MQTT URL
        if (!homeyIP) {
          const mqttMatch = configContent.match(/mqtt:\s*{\s*url:\s*["']mqtt:\/\/([^:"']+)/);
          if (mqttMatch) {
            homeyIP = cleanHostname(mqttMatch[1]);
            source = "MQTT url";
          }
        }
        
        // PRIORITY 2: Global Homey_API or homeyToken
        if (!homeyToken) {
          const apiMatch = configContent.match(/const\s+Homey_API\s*=\s*["']([^"']+)["']/);
          const tokenMatch = configContent.match(/const\s+homeyToken\s*=\s*["']([^"']+)["']/);
          
          if (apiMatch) homeyToken = apiMatch[1];
          if (tokenMatch) homeyToken = tokenMatch[1];
        }
        
        if (homeyIP || homeyToken) {
          console.log(`✓ Found config at: ${configPath}`);
          if (homeyIP) console.log(`✓ Using Homey IP: ${homeyIP} (from ${source})`);
          if (homeyToken) console.log(`✓ Using Homey token from config`);
          return { token: homeyToken, ip: homeyIP };
        }
      }
    }
  } catch (error) {
    // Silently skip on error
  }
  return { token: null, ip: null };
}

// ============================================================================
// PARSE COMMAND LINE
// ============================================================================
const args = process.argv.slice(2);
let homeyIPOverride = null;
let homeyTokenOverride = null;
let nameFilter = "";
let capabilityFilter = "";

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--ip' && args[i + 1]) {
    homeyIPOverride = args[i + 1];
  } else if (args[i] === '--token' && args[i + 1]) {
    homeyTokenOverride = args[i + 1];
  } else if (!args[i].startsWith('--')) {
    if (!nameFilter) {
      nameFilter = args[i];
    } else if (!capabilityFilter) {
      capabilityFilter = args[i];
    }
  }
}

const configFromFile = loadConfigFromMagicMirror();
const HOMEY_IP = homeyIPOverride || configFromFile.ip;
const HOMEY_TOKEN = homeyTokenOverride || configFromFile.token;

if (!HOMEY_IP || !HOMEY_TOKEN) {
  console.error("\n❌ Error: MMM-HomeyIntegration is not configured!");
  console.error("\nThe discovery tool requires your MMM-HomeyIntegration module config.");
  console.error("\nSetup steps:");
  console.error("  1. Open config/config.js");
  console.error("  2. Find or add the MMM-HomeyIntegration module config:");
  console.error("     {");
  console.error("       module: \"MMM-HomeyIntegration\",");
  console.error("       config: {");
  console.error("         api: {");
  console.error("           enabled: true,");
  console.error("           baseUrl: \"http://192.168.10.35\",");
  console.error("           headers: {");
  console.error("             Authorization: \"Bearer YOUR_HOMEY_API_TOKEN\"");
  console.error("           }");
  console.error("         }");
  console.error("       }");
  console.error("     }");
  console.error("  3. Replace with your actual Homey IP and API token");
  console.error("  4. Save config.js");
  console.error("  5. Run: npm run discover\n");
  console.error("Or use command-line args (optional override):");
  console.error("  npm run discover -- --ip 192.168.10.35 --token YOUR_TOKEN\n");
  process.exit(1);
}

// ============================================================================
// FETCH DEVICES FROM HOMEY API
// ============================================================================
async function fetchHomeyDevices() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: HOMEY_IP,
      path: "/api/manager/devices/device",
      method: "GET",
      headers: {
        Authorization: `Bearer ${HOMEY_TOKEN}`
      }
    };

    http.get(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON: ${e.message}`));
        }
      });
    }).on("error", reject);
  });
}

// ============================================================================
// FILTER AND FORMAT
// ============================================================================
function matchesPattern(text, pattern) {
  if (!pattern) return true;
  
  const regex = new RegExp(
    pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.'),
    'i'
  );
  
  return regex.test(text);
}

function formatCapabilityValue(cap) {
  if (cap.value === null || cap.value === undefined) return "null";
  if (typeof cap.value === "number") return cap.value.toFixed(2);
  if (typeof cap.value === "boolean") return cap.value ? "✓" : "✗";
  return String(cap.value);
}

function getCapabilityUnit(cap) {
  if (!cap.units || cap.units.length === 0) return "";
  if (Array.isArray(cap.units)) return cap.units[0] || "";
  return cap.units;
}

function getCapabilityType(cap) {
  const types = cap.types || [];
  return Array.isArray(types) ? types.join(", ") : String(types);
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  try {
    console.log("\n🔍 Fetching Homey devices from", HOMEY_IP, "...\n");
    
    const devices = await fetchHomeyDevices();
    
    if (!devices || Object.keys(devices).length === 0) {
      console.error("❌ No devices found or invalid response from Homey API");
      process.exit(1);
    }

    const filtered = Object.entries(devices)
      .filter(([id, device]) => {
        const nameMatch = matchesPattern(device.name || "", nameFilter);
        let capMatch = true;
        
        if (capabilityFilter) {
          capMatch = Object.keys(device.capabilitiesObj || {}).some(cap =>
            matchesPattern(cap, capabilityFilter)
          );
        }
        
        return nameMatch && capMatch;
      });

    if (filtered.length === 0) {
      console.log("❌ No devices matched filters:");
      console.log(`   Name: "${nameFilter || "(any)"}"`);
      console.log(`   Capability: "${capabilityFilter || "(any)"}"\n`);
      process.exit(0);
    }

    console.log(`✓ Found ${filtered.length} device(s)\n`);
    console.log("═".repeat(80));

    filtered.forEach(([id, device]) => {
      console.log(`\n📱 ${device.name}`);
      console.log(`   ID: ${id}`);
      console.log(`   Class: ${device.class || "unknown"}`);
      
      const capabilities = device.capabilitiesObj || {};
      const capList = Object.entries(capabilities);
      
      if (capList.length > 0) {
        console.log(`   Capabilities (${capList.length}):`);
        
        capList.forEach(([capName, capObj]) => {
          const value = formatCapabilityValue(capObj);
          const unit = getCapabilityUnit(capObj);
          const unitStr = unit ? ` [${unit}]` : "";
          
          console.log(`     • ${capName}: ${value}${unitStr}`);
          
          // Show MQTT topic hint for this capability
          console.log(`       MQTT: homey/devices/${id}/capabilities/${capName}/value`);
        });
      }
      
      console.log(`\n   Ready-to-use for MMM-HomeyIntegration:`);
      console.log(`   ─────────────────────────────────────`);
      
      // Suggest MQTT topic config
      capList.forEach(([capName, capObj]) => {
        const notifType = capName.includes("temperature") 
          ? "INDOOR_TEMPERATURE"
          : capName.includes("humidity")
          ? "INDOOR_HUMIDITY"
          : capName.includes("power")
          ? "POWER"
          : "CUSTOM_NOTIFICATION";
        
        console.log(`\n   MQTT topic (for config.js):`);
        console.log(`   {`);
        console.log(`     topic: "homey/devices/${id}/capabilities/${capName}/value",`);
        console.log(`     parser: "plain",`);
        console.log(`     action: {`);
        console.log(`       type: "notification",`);
        console.log(`       notification: "${notifType}"`);
        console.log(`     }`);
        console.log(`   }`);
      });
    });

    console.log("\n" + "═".repeat(80));
    console.log("\n💡 Tips:");
    console.log("   • Copy MQTT topics into MMM-HomeyIntegration config.mqtt.topics");
    console.log("   • Use display type 'display' for snapshots (images)");
    console.log("   • Use type 'notification' for sensor values (temperature, humidity, etc)");
    console.log("   • Ensure MMM-HomeyIntegration has mqtt.enabled: true\n");

  } catch (error) {
    console.error("❌ Error:", error.message);
    console.error("\nTroubleshooting:");
    console.error("   • Check Homey IP is correct");
    console.error("   • Check Homey API token is valid");
    console.error("   • Ensure Homey is reachable on network\n");
    process.exit(1);
  }
}

main();
