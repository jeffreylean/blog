use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Deserialize)]
struct Config {
    api_url: String,
    api_key: String,
}

#[derive(Parser)]
#[command(name = "bookmark", about = "Bookmark CLI for managing saved links")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// List bookmarks with optional filters
    List {
        /// Filter by tag
        #[arg(long)]
        tag: Option<String>,
        /// Show only untagged bookmarks
        #[arg(long)]
        untagged: bool,
        /// Show only unread bookmarks
        #[arg(long)]
        unread: bool,
    },
    /// Add a new bookmark
    Add {
        /// URL to bookmark
        url: String,
    },
    /// Update an existing bookmark
    Update {
        /// Bookmark ID
        id: u64,
        /// Comma-separated tags
        #[arg(long)]
        tags: Option<String>,
        /// Note to attach
        #[arg(long)]
        note: Option<String>,
        /// Mark as read
        #[arg(long)]
        read: bool,
    },
    /// Manage tags
    Tags {
        #[command(subcommand)]
        action: Option<TagAction>,
    },
    /// Export bookmarks as JSON
    Export {
        /// Export only untagged bookmarks
        #[arg(long)]
        untagged: bool,
        /// Output as JSON (required)
        #[arg(long)]
        json: bool,
    },
    /// Import batch updates from a JSON file
    Import {
        /// Path to JSON file
        file: PathBuf,
    },
}

#[derive(Subcommand)]
enum TagAction {
    /// Approve a pending tag
    Approve { name: String },
    /// Add a new approved tag
    Add { name: String },
}

#[derive(Deserialize)]
struct BookmarkListResponse {
    bookmarks: Vec<Bookmark>,
    total: u64,
}

#[derive(Deserialize, Serialize)]
struct Bookmark {
    id: u64,
    url: String,
    title: String,
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    is_read: Option<u8>,
    created_at: String,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
}

#[derive(Deserialize)]
struct CreateResponse {
    id: u64,
    title: String,
}

#[derive(Deserialize)]
struct TagsResponse {
    approved: Vec<Tag>,
    pending: Vec<Tag>,
}

#[derive(Deserialize)]
struct Tag {
    name: String,
}

#[derive(Deserialize)]
struct BatchResponse {
    updated: u64,
}

#[derive(Deserialize)]
struct ErrorResponse {
    error: String,
}

fn load_config() -> Config {
    let config_path = config_path();
    let content = match std::fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(_) => {
            eprintln!(
                "Error: Config file not found at {}\n\n\
                 Create it with:\n  \
                 mkdir -p ~/.config/bookmark\n  \
                 cat > ~/.config/bookmark/config.toml << 'EOF'\n  \
                 api_url = \"https://bookmarks.leanwf1117.workers.dev\"\n  \
                 api_key = \"your-api-key\"\n  \
                 EOF",
                config_path.display()
            );
            std::process::exit(1);
        }
    };

    let config: Config = match toml::from_str(&content) {
        Ok(c) => c,
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("api_url") {
                eprintln!("Error: api_url is missing from {}", config_path.display());
            } else if msg.contains("api_key") {
                eprintln!("Error: api_key is missing from {}", config_path.display());
            } else {
                eprintln!("Error: Invalid config file: {msg}");
            }
            std::process::exit(1);
        }
    };

    if config.api_url.is_empty() {
        eprintln!("Error: api_url is empty in {}", config_path.display());
        std::process::exit(1);
    }
    if config.api_key.is_empty() {
        eprintln!("Error: api_key is empty in {}", config_path.display());
        std::process::exit(1);
    }

    config
}

fn config_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home)
        .join(".config")
        .join("bookmark")
        .join("config.toml")
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let config = load_config();
    let client = reqwest::Client::new();

    match cli.command {
        Commands::List {
            tag,
            untagged,
            unread,
        } => cmd_list(&config, &client, tag, untagged, unread).await,
        Commands::Add { url } => cmd_add(&config, &client, &url).await,
        Commands::Update {
            id,
            tags,
            note,
            read,
        } => cmd_update(&config, &client, id, tags, note, read).await,
        Commands::Tags { action } => cmd_tags(&config, &client, action).await,
        Commands::Export { untagged, json } => cmd_export(&config, &client, untagged, json).await,
        Commands::Import { file } => cmd_import(&config, &client, &file).await,
    }
}

async fn cmd_list(
    config: &Config,
    client: &reqwest::Client,
    tag: Option<String>,
    untagged: bool,
    unread: bool,
) {
    let mut params = vec![];
    if let Some(t) = &tag {
        params.push(format!("tag={t}"));
    }
    if untagged {
        params.push("untagged=true".to_string());
    }
    if unread {
        params.push("unread=true".to_string());
    }
    let qs = if params.is_empty() {
        String::new()
    } else {
        format!("?{}", params.join("&"))
    };

    let resp = client
        .get(format!("{}/bookmarks{qs}", config.api_url))
        .send()
        .await;

    match resp {
        Ok(r) if r.status().is_success() => {
            let data: BookmarkListResponse = r.json().await.unwrap();
            if data.bookmarks.is_empty() {
                println!("No bookmarks found.");
                return;
            }
            println!("{:<6} {:<50} {:<20} DATE", "ID", "TITLE", "TAGS");
            println!("{}", "-".repeat(90));
            for b in &data.bookmarks {
                let title = if b.title.len() > 48 {
                    format!("{}...", &b.title[..45])
                } else {
                    b.title.clone()
                };
                let tags = b.tags.join(", ");
                let tags_display = if tags.len() > 18 {
                    format!("{}...", &tags[..15])
                } else {
                    tags
                };
                let date = &b.created_at[..10];
                println!("{:<6} {:<50} {:<20} {date}", b.id, title, tags_display);
            }
            println!("\nTotal: {}", data.total);
        }
        Ok(r) => print_error(r).await,
        Err(e) => eprintln!("Error: {e}"),
    }
}

async fn cmd_add(config: &Config, client: &reqwest::Client, url: &str) {
    let resp = client
        .post(format!("{}/bookmarks", config.api_url))
        .header("Authorization", format!("Bearer {}", config.api_key))
        .json(&serde_json::json!({ "url": url }))
        .send()
        .await;

    match resp {
        Ok(r) if r.status().is_success() => {
            let data: CreateResponse = r.json().await.unwrap();
            println!("Created bookmark #{}: {}", data.id, data.title);
        }
        Ok(r) => print_error(r).await,
        Err(e) => eprintln!("Error: {e}"),
    }
}

async fn cmd_update(
    config: &Config,
    client: &reqwest::Client,
    id: u64,
    tags: Option<String>,
    note: Option<String>,
    read: bool,
) {
    let mut body = serde_json::Map::new();
    if let Some(t) = tags {
        let tag_list: Vec<&str> = t.split(',').map(|s| s.trim()).collect();
        body.insert(
            "tags".to_string(),
            serde_json::Value::Array(tag_list.into_iter().map(|s| s.into()).collect()),
        );
    }
    if let Some(n) = note {
        body.insert("note".to_string(), n.into());
    }
    if read {
        body.insert("is_read".to_string(), true.into());
    }

    let resp = client
        .patch(format!("{}/bookmarks/{id}", config.api_url))
        .header("Authorization", format!("Bearer {}", config.api_key))
        .json(&body)
        .send()
        .await;

    match resp {
        Ok(r) if r.status().is_success() => {
            let b: Bookmark = r.json().await.unwrap();
            println!("Updated bookmark #{}:", b.id);
            println!("  Title: {}", b.title);
            println!("  Tags:  {}", b.tags.join(", "));
            if let Some(note) = &b.note {
                println!("  Note:  {note}");
            }
            println!(
                "  Read:  {}",
                if b.is_read.unwrap_or(0) == 1 {
                    "yes"
                } else {
                    "no"
                }
            );
        }
        Ok(r) => print_error(r).await,
        Err(e) => eprintln!("Error: {e}"),
    }
}

async fn cmd_tags(config: &Config, client: &reqwest::Client, action: Option<TagAction>) {
    match action {
        None => {
            let resp = client.get(format!("{}/tags", config.api_url)).send().await;
            match resp {
                Ok(r) if r.status().is_success() => {
                    let data: TagsResponse = r.json().await.unwrap();
                    println!("Approved tags:");
                    for t in &data.approved {
                        println!("  {}", t.name);
                    }
                    if !data.pending.is_empty() {
                        println!("\nPending tags:");
                        for t in &data.pending {
                            println!("  {}", t.name);
                        }
                    }
                }
                Ok(r) => print_error(r).await,
                Err(e) => eprintln!("Error: {e}"),
            }
        }
        Some(TagAction::Approve { name }) => {
            let resp = client
                .post(format!("{}/tags/approve", config.api_url))
                .header("Authorization", format!("Bearer {}", config.api_key))
                .json(&serde_json::json!({ "name": name }))
                .send()
                .await;
            match resp {
                Ok(r) if r.status().is_success() => println!("Tag '{name}' approved."),
                Ok(r) => print_error(r).await,
                Err(e) => eprintln!("Error: {e}"),
            }
        }
        Some(TagAction::Add { name }) => {
            let resp = client
                .post(format!("{}/tags", config.api_url))
                .header("Authorization", format!("Bearer {}", config.api_key))
                .json(&serde_json::json!({ "name": name }))
                .send()
                .await;
            match resp {
                Ok(r) if r.status().is_success() => println!("Tag '{name}' created."),
                Ok(r) => print_error(r).await,
                Err(e) => eprintln!("Error: {e}"),
            }
        }
    }
}

async fn cmd_export(config: &Config, client: &reqwest::Client, untagged: bool, json: bool) {
    if !json {
        eprintln!("Error: --json flag is required");
        std::process::exit(1);
    }

    let mut params = vec!["limit=1000".to_string()];
    if untagged {
        params.push("untagged=true".to_string());
    }
    let qs = format!("?{}", params.join("&"));

    let resp = client
        .get(format!("{}/bookmarks{qs}", config.api_url))
        .send()
        .await;

    match resp {
        Ok(r) if r.status().is_success() => {
            let data: BookmarkListResponse = r.json().await.unwrap();
            let export: Vec<serde_json::Value> = data
                .bookmarks
                .iter()
                .map(|b| {
                    serde_json::json!({
                        "id": b.id,
                        "url": b.url,
                        "title": b.title,
                        "created_at": b.created_at,
                    })
                })
                .collect();
            println!("{}", serde_json::to_string_pretty(&export).unwrap());
        }
        Ok(r) => print_error(r).await,
        Err(e) => eprintln!("Error: {e}"),
    }
}

async fn cmd_import(config: &Config, client: &reqwest::Client, file: &PathBuf) {
    let content = match std::fs::read_to_string(file) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Error reading file: {e}");
            std::process::exit(1);
        }
    };

    let updates: Vec<serde_json::Value> = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("Error: Invalid JSON: {e}");
            std::process::exit(1);
        }
    };

    let resp = client
        .post(format!("{}/bookmarks/batch", config.api_url))
        .header("Authorization", format!("Bearer {}", config.api_key))
        .json(&serde_json::json!({ "updates": updates }))
        .send()
        .await;

    match resp {
        Ok(r) if r.status().is_success() => {
            let data: BatchResponse = r.json().await.unwrap();
            println!("Updated {} bookmarks.", data.updated);
        }
        Ok(r) => print_error(r).await,
        Err(e) => eprintln!("Error: {e}"),
    }
}

async fn print_error(r: reqwest::Response) {
    let err: ErrorResponse = r.json().await.unwrap_or(ErrorResponse {
        error: "Unknown error".to_string(),
    });
    eprintln!("Error: {}", err.error);
}
