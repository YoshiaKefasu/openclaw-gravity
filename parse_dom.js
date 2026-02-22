import fs from "fs"
const html = fs.readFileSync("dom_fresh.html", "utf-8")

// Looking for the latest chat bubble text pattern in Cascade
// Usually it's in a div with "leading-relaxed"
const matches = [
	...html.matchAll(/<div[^>]*class="[^"]*leading-relaxed[^"]*"[^>]*>(.*?)<\/div>/gi),
]
console.log("Found:", matches.length)
if (matches.length > 0) {
	const last = matches[matches.length - 1][1]
	console.log(
		last
			.replace(/<[^>]+>/g, "")
			.trim()
			.substring(0, 200),
	)
}
