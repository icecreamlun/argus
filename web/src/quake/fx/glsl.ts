/** Shared GLSL snippets (hash / value noise / fbm). */

export const NOISE_GLSL = /* glsl */ `
float hash12( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.x + p3.y ) * p3.z );
}
float vnoise( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	vec2 u = f * f * ( 3.0 - 2.0 * f );
	float a = hash12( i );
	float b = hash12( i + vec2( 1.0, 0.0 ) );
	float c = hash12( i + vec2( 0.0, 1.0 ) );
	float d = hash12( i + vec2( 1.0, 1.0 ) );
	return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}
float fbm3( vec2 p ) {
	float s = 0.0;
	float a = 0.5;
	for ( int i = 0; i < 3; i ++ ) {
		s += a * vnoise( p );
		p = p * 2.03 + vec2( 17.1, 9.2 );
		a *= 0.5;
	}
	return s / 0.875;
}
float fbm5( vec2 p ) {
	float s = 0.0;
	float a = 0.5;
	for ( int i = 0; i < 5; i ++ ) {
		s += a * vnoise( p );
		p = p * 2.02 + vec2( 17.1, 9.2 );
		a *= 0.5;
	}
	return s / 0.96875;
}
`;

/** Rodrigues rotation of v about unit axis k by angle a. */
export const ROTATE_GLSL = /* glsl */ `
vec3 rotAxis( vec3 v, vec3 k, float a ) {
	float c = cos( a );
	float s = sin( a );
	return v * c + cross( k, v ) * s + k * dot( k, v ) * ( 1.0 - c );
}
`;
