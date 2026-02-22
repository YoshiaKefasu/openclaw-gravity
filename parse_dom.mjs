const fs = require("fs")
const html = fs.readFileSync("dom_dump.html", "utf-8")

// The chat title is usually inside a <header> or a <div> with specific classes
// Let's find all text contents of elements that might be the title
const matches = [
	...html.matchAll(/<[^>]+class="([^"]*title[^"]*)"[^>]*>(.*?)<\/[^>]+>/gi),
]
const results = matches
	.map((m) => ({ class: m[1], text: m[2].replace(/<[^>]+>/g, "").trim() }))
	.filter((r) => r.text.length > 0)

console.log("Found Title-like elements:")
console.log(results.slice(0, 20))

// Also let's check for elements that have a tooltip or aria-label about chat history
const arias = [...html.matchAll(/aria-label="([^"]*)"[^>]*>(.*?)<\/[^>]+>/gi)]
console.log("\nAria labels:")
console.log(
	arias
		.map((m) => m[1])
		.filter((a) => a.length > 10)
		.slice(0, 20),
)
