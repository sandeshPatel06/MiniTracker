export namespace db {
	
	export class UserUsageBreakdown {
	    user_id: number;
	    full_name: string;
	    email: string;
	    role: string;
	    total_requests: number;
	    prompt_tokens: number;
	    candidate_tokens: number;
	    total_tokens: number;
	
	    static createFrom(source: any = {}) {
	        return new UserUsageBreakdown(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.user_id = source["user_id"];
	        this.full_name = source["full_name"];
	        this.email = source["email"];
	        this.role = source["role"];
	        this.total_requests = source["total_requests"];
	        this.prompt_tokens = source["prompt_tokens"];
	        this.candidate_tokens = source["candidate_tokens"];
	        this.total_tokens = source["total_tokens"];
	    }
	}
	export class APIUsageSummary {
	    total_requests: number;
	    prompt_tokens: number;
	    candidate_tokens: number;
	    total_tokens: number;
	    by_key_source: Record<string, number>;
	    user_breakdown?: UserUsageBreakdown[];
	
	    static createFrom(source: any = {}) {
	        return new APIUsageSummary(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.total_requests = source["total_requests"];
	        this.prompt_tokens = source["prompt_tokens"];
	        this.candidate_tokens = source["candidate_tokens"];
	        this.total_tokens = source["total_tokens"];
	        this.by_key_source = source["by_key_source"];
	        this.user_breakdown = this.convertValues(source["user_breakdown"], UserUsageBreakdown);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class CalendarEvent {
	    id: number;
	    integration_id: number;
	    external_id: string;
	    title: string;
	    description: string;
	    // Go type: time
	    start_time: any;
	    // Go type: time
	    end_time: any;
	    all_day: boolean;
	    status: string;
	    meeting_url: string;
	    is_matched: boolean;
	    matched_log_id?: number;
	    // Go type: time
	    created_at: any;
	
	    static createFrom(source: any = {}) {
	        return new CalendarEvent(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.integration_id = source["integration_id"];
	        this.external_id = source["external_id"];
	        this.title = source["title"];
	        this.description = source["description"];
	        this.start_time = this.convertValues(source["start_time"], null);
	        this.end_time = this.convertValues(source["end_time"], null);
	        this.all_day = source["all_day"];
	        this.status = source["status"];
	        this.meeting_url = source["meeting_url"];
	        this.is_matched = source["is_matched"];
	        this.matched_log_id = source["matched_log_id"];
	        this.created_at = this.convertValues(source["created_at"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class CalendarIntegration {
	    id: number;
	    user_id: number;
	    provider: string;
	    account_email: string;
	    display_name: string;
	    encrypted_tokens?: string;
	    sync_status: string;
	    // Go type: time
	    last_synced_at?: any;
	    sync_token?: string;
	    auto_match_enabled: boolean;
	    // Go type: time
	    created_at: any;
	
	    static createFrom(source: any = {}) {
	        return new CalendarIntegration(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.user_id = source["user_id"];
	        this.provider = source["provider"];
	        this.account_email = source["account_email"];
	        this.display_name = source["display_name"];
	        this.encrypted_tokens = source["encrypted_tokens"];
	        this.sync_status = source["sync_status"];
	        this.last_synced_at = this.convertValues(source["last_synced_at"], null);
	        this.sync_token = source["sync_token"];
	        this.auto_match_enabled = source["auto_match_enabled"];
	        this.created_at = this.convertValues(source["created_at"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class DistractionRule {
	    id: number;
	    org_id: number;
	    user_id: number;
	    kind: string;
	    pattern: string;
	    is_distraction: boolean;
	    // Go type: time
	    created_at: any;
	
	    static createFrom(source: any = {}) {
	        return new DistractionRule(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.org_id = source["org_id"];
	        this.user_id = source["user_id"];
	        this.kind = source["kind"];
	        this.pattern = source["pattern"];
	        this.is_distraction = source["is_distraction"];
	        this.created_at = this.convertValues(source["created_at"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class LogEntry {
	    id: number;
	    org_id: number;
	    user_id: number;
	    // Go type: time
	    timestamp: any;
	    image_path: string;
	    total_keys: number;
	    unique_keys: number;
	    entropy_score: number;
	    total_clicks: number;
	    mouse_distance: number;
	    app_name: string;
	    app_category: string;
	    window_title: string;
	    session_id: number;
	    session_title: string;
	    ai_category: string;
	    is_productive: boolean;
	    productive_score: number;
	    ai_confidence: number;
	    ai_reason: string;
	    ai_retry_count: number;
	    sync_status: string;
	    remote_id: number;
	    // Go type: time
	    synced_at: any;
	    is_blurred: boolean;
	    blur_reason: string;
	    is_retroactive: boolean;
	    idle_interval_id: number;
	
	    static createFrom(source: any = {}) {
	        return new LogEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.org_id = source["org_id"];
	        this.user_id = source["user_id"];
	        this.timestamp = this.convertValues(source["timestamp"], null);
	        this.image_path = source["image_path"];
	        this.total_keys = source["total_keys"];
	        this.unique_keys = source["unique_keys"];
	        this.entropy_score = source["entropy_score"];
	        this.total_clicks = source["total_clicks"];
	        this.mouse_distance = source["mouse_distance"];
	        this.app_name = source["app_name"];
	        this.app_category = source["app_category"];
	        this.window_title = source["window_title"];
	        this.session_id = source["session_id"];
	        this.session_title = source["session_title"];
	        this.ai_category = source["ai_category"];
	        this.is_productive = source["is_productive"];
	        this.productive_score = source["productive_score"];
	        this.ai_confidence = source["ai_confidence"];
	        this.ai_reason = source["ai_reason"];
	        this.ai_retry_count = source["ai_retry_count"];
	        this.sync_status = source["sync_status"];
	        this.remote_id = source["remote_id"];
	        this.synced_at = this.convertValues(source["synced_at"], null);
	        this.is_blurred = source["is_blurred"];
	        this.blur_reason = source["blur_reason"];
	        this.is_retroactive = source["is_retroactive"];
	        this.idle_interval_id = source["idle_interval_id"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class PrivacyRule {
	    id: number;
	    rule_type: string;
	    pattern: string;
	    action: string;
	    description: string;
	    is_active: boolean;
	    is_built_in: boolean;
	    // Go type: time
	    created_at: any;
	
	    static createFrom(source: any = {}) {
	        return new PrivacyRule(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.rule_type = source["rule_type"];
	        this.pattern = source["pattern"];
	        this.action = source["action"];
	        this.description = source["description"];
	        this.is_active = source["is_active"];
	        this.is_built_in = source["is_built_in"];
	        this.created_at = this.convertValues(source["created_at"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ProductivityStats {
	    date: string;
	    total_minutes: number;
	    productive_minutes: number;
	    unproductive_minutes: number;
	    avg_entropy_score: number;
	    top_category: string;
	
	    static createFrom(source: any = {}) {
	        return new ProductivityStats(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.date = source["date"];
	        this.total_minutes = source["total_minutes"];
	        this.productive_minutes = source["productive_minutes"];
	        this.unproductive_minutes = source["unproductive_minutes"];
	        this.avg_entropy_score = source["avg_entropy_score"];
	        this.top_category = source["top_category"];
	    }
	}

}

