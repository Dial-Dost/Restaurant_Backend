import { createClient } from "@supabase/supabase-js";

let hasWarnedMissingConfig = false;

const getSupabaseStorageClient = () => {
    const url = process.env.SUPABASE_PROJECT_URL;
    const key = process.env.SUPABASE_DEFAULT_API_KEY;

    if (!url || !key) {
        if (!hasWarnedMissingConfig) {
            hasWarnedMissingConfig = true;
            console.warn(
                "Supabase storage is disabled: missing SUPABASE_PROJECT_URL or SUPABASE_DEFAULT_API_KEY."
            );
        }
        return null;
    }

    return createClient(url, key);
};

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
    const supabase = getSupabaseStorageClient();
    if (!supabase) {
        return null;
    }

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