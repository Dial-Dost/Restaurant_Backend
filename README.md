# server

## If you use bun
To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```
## To run without bun
```bash
node ./build/index.js
```

## Pathway
- Runs on port 3000


### /add-customer
Needs request body as
```json
{
    "customer": {
        "name": "Example",
            "number": "+91 9923523232", // try keeping all in the same format whatever the format is
            "email": "k@gmail.com" // Optional
    }
}
```
returns the customer_id if you want to store it somewhere

### /add-table
Needs request body as
```json
{
    "table": {
        "name": "T1",
            "capacity": 4 // Optional
    }
}
```
returns the table_name if you want to store it somewhere

### /add-booking
Needs request body as
```json
{
    // creates customer if the name+number does not exist
    "customer": {
        "name": "Jhon",
            "number": "9972955566",
            "email": "example@gmail.com" //optional
    },
        // Table must exist
        "booking": {
            "table_name": "T1",
            "date": "YYYY-MM-DDThh:mm:ssTZD"
                "duration": "30" // in minutes
                "number_of_people": "3"
        }
    ```
}
returns the booking id

## Todo
Implementing auth for each request
