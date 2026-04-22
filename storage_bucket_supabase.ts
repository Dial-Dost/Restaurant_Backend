import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
    process.env.SUPABASE_PROJECT_URL!,
    process.env.SUPABASE_DEFAULT_API_KEY!
);

// const { data, error } = await supabase.storage
//     .from("logos")
//     // .createSignedUrl("res_logo_placeholder.jpg", 60);;
//     .list();

// if (error) {
//     console.error("Storage access failed:", error.message);
// } else {
//     console.log("Files in bucket:", data);
// }


export async function downloadFile(url: string): Promise<Blob | null> {
    const bucket = url.split('/')[0];
    const path = url.split('/').slice(1).join('/');

    if(!bucket || !path) {
        console.error('Invalid URL format. Expected format: bucket/path/to/file');
        return null;
    }

    const { data, error } = await supabase.storage.from(bucket).download(path);
    if (error) {
        console.error('Error downloading file:', error);
        return null;
    }

    return data;
}